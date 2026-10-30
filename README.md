# The pi-cpu-sample extension

Kill switch: create `~/.config/cpu-sample/disabled`, or start pi with `CPU_SAMPLE=off`. A running sampler stops at its next tick and then idles for as long as the file is there.

A pi extension that records what one coding session costs in CPU. Each 30-second sample, taken from `session_start` to `session_shutdown`, sums the CPU of the pi process tree and of the tagged processes that escaped it, and it adds the Docker compose stacks whose working directory sits under the session's cwd. A separate field records the Docker VM's host-side share. The timer appends one `cpu-sample` entry to the session file per tick, and pi never sends those entries to the model.

## Install

```bash
pi install git:github.com/elecnix/pi-cpu-sample
```

Reload with `/reload`, or restart pi. Every process the session spawns then inherits `CPU_SAMPLE_SESSION=pi:<session id>` in its environment. That tag is how the sampler attributes a process whose parent has already exited.

## The fields in a sample

Every number is cumulative CPU seconds, so a missed tick loses nothing. The reader subtracts consecutive samples.

| Field | What it holds |
| --- | --- |
| `agent_cpu_s` | The pi process's own CPU. In-process sampling adds the sampler's cost to it. Each record states that cost in `sample_cpu_s`. |
| `descendant_cpu_s` | Live tree members plus the time their parents reaped, which folds in short-lived children that exited between samples. |
| `tagged_orphan_cpu_s` | Processes tagged `CPU_SAMPLE_SESSION` that left the tree, such as a dev server started by a shell that has since exited. |
| `procs` | Live session processes, largest first, capped at 64. |
| `docker.stacks[]` | Per compose stack: the working directory and project name, plus the cumulative container CPU per container id. |
| `docker_vm_cpu_s` | Cumulative CPU of every Docker Desktop host process (the Linux VM included, plus its backend and helper processes). Container work produces the `docker.stacks[]` numbers separately. |

## The mechanisms behind the numbers

On macOS, one `sysctl(KERN_PROC_ALL)` call reads the process table, `proc_pid_rusage` reads each session process, and `ps -axEww` checks the environment of new processes outside the tree for the tag. On Linux, `/proc/<pid>/stat` holds the CPU and `/proc/<pid>/environ` holds the tag. The table costs one syscall per tick. Everything else costs one call per process.

A process that was ever a tree member remains attributed after its original parent exits, and the sampler doesn't read its environment again. A process the sampler never saw inside the tree counts only when its environment has the tag.

## Limits

- A reparented process that starts and exits between two samples loses its CPU, bounded by one 30-second interval.
- Hardened or SIP-protected binaries hide their environment, so the tag inside such a process is invisible. Tree membership still attributes the process while it remains inside the tree.
- A process that runs `env -i` drops the tag.
- Container CPU reaches the ledger through compose labels. A stack started outside the session's cwd goes unsampled, and a stack that keeps running after its session's sampler stops goes unsampled too.
- macOS system daemons that work on the session's behalf (Spotlight indexing, XProtect) belong to no session, so no ledger records them.

## Privacy

A sample lists the session's processes with a name and a pid each, and reports CPU seconds for the agent, the descendants, the tagged strays, and each Docker stack. The sampler doesn't record command lines, environment values beyond the tag, or file contents. The sampler drops command lines and every environment value except the tag variable. It never reads file contents.
