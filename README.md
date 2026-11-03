# The pi-cpu-sample extension

Kill switch: create `~/.config/cpu-sample/disabled`, or start pi with `CPU_SAMPLE=off`. A running sampler stops at its next tick and then idles for as long as the file is there.

A pi extension that records what one coding session costs in CPU. Each 30-second sample, taken from `session_start` to `session_shutdown`, sums the CPU of the pi process tree and of the tagged processes that escaped it, and it adds the Docker compose stacks whose working directory sits under the session's cwd. A separate field records the Docker VM's host-side share. The timer appends one `cpu-sample` entry to the session file per tick, and pi never sends those entries to the model. Sampling pauses while the session is idle, so fifty open sessions cost fifty idle checkers rather than fifty samplers.

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

## Sampling while the session is idle

A session is idle when all of these hold:

- no turn is in progress, meaning `agent_start` fired and `agent_settled` has not;
- the agent's descendants are the same processes as at the last check, and they used less than 1% of one core between the two checks;
- every session member outside the agent's tree, tagged or reparented, has exited. The check reads the pid as alive or gone. macOS 27 doesn't report a process start time, so a pid that changed hands since the last sample also reads as alive. The session then samples once more.

An idle session skips the process table and Docker entirely. The resume check runs every 30 seconds. It looks at one process at a time, `proc_listchildpids` on macOS or one `/proc/<pid>/task/<pid>/children` read on Linux, and it stops at the first process with no children.

Waking is immediate. pi emits `agent_start` before a turn does any work, and the sampler takes a full sample then.

Counters are cumulative, so a pause keeps the totals exact. Pause and resume bracket the gap, and the reader subtracts the two samples. `npm run bench:idle` measures the check on this machine:

| What | CPU per tick, 30 s ticks | CPU per hour |
| --- | --- | --- |
| Idle check, 1 session | 94 us | 0.011 s |
| Idle check, 20 sessions | 1.6 ms, 82 us each | 0.20 s |
| Full sample, Docker stubbed out | 9 to 18 ms | 1.1 to 2.1 s |

Fifty idle sessions use about 0.6 CPU-seconds an hour. Fifty sampling sessions use 55 to 105.

Sessions that pause stop watching their Docker stacks. A stack that keeps running after its turn ends counts toward the session that started it only until the idle began, and the reader's own snapshots record the rest as an unowned stack.

## The mechanisms behind the numbers

On macOS, one `sysctl(KERN_PROC_ALL)` call reads the process table, `proc_pid_rusage` reads each session process, and `ps -axEww` checks the environment of new processes outside the tree for the tag. On Linux, `/proc/<pid>/stat` holds the CPU and `/proc/<pid>/environ` holds the tag. The table costs one syscall per tick. Everything else costs one call per process.

A process that was ever a tree member remains attributed after its original parent exits, and the sampler doesn't read its environment again. A process the sampler never saw inside the tree counts only when its environment has the tag.

## Limits

- A reparented process that starts and exits between two samples loses its CPU, bounded by one 30-second interval.
- Hardened or SIP-protected binaries hide their environment, so the tag inside such a process is invisible. Tree membership still attributes the process while it remains inside the tree.
- A process that runs `env -i` drops the tag.
- Container CPU reaches the ledger through compose labels. A stack started outside the session's cwd goes unsampled. A stack that keeps running while its session is idle counts for the session only until the idle began, and the reader's snapshots record the rest as unowned.
- A daemon that starts while the session is idle, such as a double-forked background server, shows up in the next sample. Its counter is cumulative, so no CPU goes missing. The one exception is a process that starts and exits entirely inside a pause, with no child the check could see.
- macOS system daemons that work on the session's behalf (Spotlight indexing, XProtect) belong to no session, so no ledger records them.

## Privacy

A sample lists the session's processes with a name and a pid each, and reports CPU seconds for the agent, the descendants, the tagged strays, and each Docker stack. The sampler doesn't record command lines, environment values beyond the tag, or file contents. The sampler drops command lines and every environment value except the tag variable. It never reads file contents.
