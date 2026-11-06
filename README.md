# The pi-cpu-sample extension

Kill switch: create `~/.config/cpu-sample/disabled`, or start pi with `CPU_SAMPLE=off`. A running sampler stops at its next tick and then idles for as long as the file is there.

A pi extension that records what one coding session costs in CPU. Every session registers with a machine-wide sampler under `~/.cache/cpu-sample`. The owner, one session among them, reads the process table, the environment scan for tagged processes, Docker, and the Docker VM once per 30-second tick, then walks each session's tree. Every other session is a contender: it takes about 0.3 ms per tick, and it takes over when the owner exits or stops beating.

Each session gets one `cpu-sample` entry in its own transcript per tick while it works, and pi never sends those entries to the model. Sampling pauses while a session is idle, so an idle session costs one resume check rather than a full read of the machine. The numbers are cumulative, so a missed tick loses nothing.

## Install

```bash
pi install git:github.com/elecnix/pi-cpu-sample
```

Reload with `/reload`, or restart pi. Every process the session spawns then inherits `CPU_SAMPLE_SESSION=pi:<session id>` in its environment. That tag is how the sampler attributes a process whose parent has already exited.

## The fields in a sample

Every number is cumulative CPU seconds, so a missed tick loses nothing. The reader subtracts consecutive samples.

| Field | What it holds |
| --- | --- |
| `agent_cpu_s` | The pi process's own CPU. When the machine-wide pass runs in this session's pi process, this includes that pass's cost. Each record states the cost in `sample_cpu_s`. |
| `descendant_cpu_s` | Live tree members plus the time their parents reaped, which folds in short-lived children that exited between samples. |
| `tagged_orphan_cpu_s` | Processes tagged `CPU_SAMPLE_SESSION` that left the tree, such as a dev server started by a shell that has since exited. |
| `procs` | Live session processes, largest first, capped at 64. |
| `docker.stacks[]` | Per compose stack: the working directory and project name, plus the cumulative container CPU per container id. |
| `docker_vm_cpu_s` | Cumulative CPU of every Docker Desktop host process (the Linux VM included, plus its backend and helper processes). A helper that exits keeps its last total, so the number only grows until the VM restarts, which `docker_vm_boot` marks. Container work produces the `docker.stacks[]` numbers separately. |

## One sampler for the machine

| File | What it stores |
| --- | --- |
| `registry/<key>.json` | One session's tag, agent pid, client pid, cwd, turn state, last delivered record, and beat. |
| `results/<key>.json` | The owner's record for one session, plus the accounting state a new owner continues from. |
| `owner.lock` | The owner's pid, session key, token, and beat. |
| `owner-state.json` | The machine-wide tag cache and the Docker VM totals. |

A contender refreshes its registration every tick, then reads the lock. When the owner process has exited, or its beat is more than 90 seconds old, the contender moves the stale record aside with one rename and creates its own, so two contenders cannot both win. A new owner restores each session's accounting state from its result file, so the run, the seq, and every cumulative total continue across the handover. When no session anywhere holds the lock, the next client to tick takes it and samples, so a session records samples with no other sampler running.

If the cache directory cannot hold the registry, the session samples itself in its own process, exactly as earlier versions did.

## Sampling while the session is idle

A session is idle when all of these hold:

- no turn is in progress: pi reports the session idle through `ctx.isIdle()`, and no `agent_start` waits for its `agent_settled`;
- the agent's descendants are the same processes as at the last check, and together they used less than half a percent of one core between the two checks;
- every session member outside the agent's tree, tagged or reparented, has exited. The check reads the pid as alive or gone. macOS 27 doesn't report a process start time, so a pid that changed hands since the last sample also reads as alive. The session then samples once more.

When every registered session is idle, the owner reads nothing but the registrations and the per-session resume checks. The check walks the agent's children one process at a time, `proc_listchildpids` on macOS or one `/proc/<pid>/task/<pid>/children` read on Linux, and it stops descending at any process that has no children. Each session's walk is the only per-session work in an idle tick. An idle tick doesn't read the process table, and it doesn't read Docker.

Waking is immediate. pi emits `agent_start` before a turn does any work. The client publishes the turn and nudges the owner with `SIGURG`. It then samples at once, because the signal's default action is to ignore it, so a reused pid is harmless.

Counters are cumulative, so a pause keeps the totals exact. Pause and resume bracket the gap, and the reader subtracts the two samples.

## Measurements

All figures come from `npm run bench:shared` on an Apple Silicon laptop with about 2,000 processes in its table. The synthetic sessions shared four quiet process trees. Numbers vary with machine load, so each cell gives the range over four runs.

| What | 1 session | 20 sessions | 100 sessions |
| --- | --- | --- | --- |
| Owner full pass, Docker stubbed out | 14 to 25 ms | 22 to 31 ms | 54 to 99 ms |
| Owner full pass, Docker live | 24 to 59 ms | 36 to 59 ms | 72 to 126 ms |
| Resume check, every session idle | 0.5 to 1.1 ms | 2.2 to 5.3 ms | 9.1 to 27 ms |
| Contender tick, per session | 0.2 to 0.4 ms | 0.2 to 0.4 ms | 0.2 to 0.4 ms |

One owner tick takes 6.5 to 15.1 CPU-seconds an hour at 100 sessions. The design this replaced ran one sampler per session: on the same machine one in-process tick cost 12 to 44 ms, so 100 sessions would have spent 140 to 522 CPU-seconds an hour.

`npm run bench:idle` measures the in-process fallback on its own, with Docker stubbed out and synthetic session trees.

## The mechanisms behind the numbers

On macOS, one `sysctl(KERN_PROC_ALL)` call reads the process table, `proc_pid_rusage` reads each session process, and `ps -axEww` checks the environment of new processes for the tag. On Linux, `/proc/<pid>/stat` holds the CPU and `/proc/<pid>/environ` holds the tag. The owner reads the table and every rusage once per tick for the whole machine and indexes them once. A session then costs one tree walk over that index.

A process that was ever a tree member remains attributed after its original parent exits, and the sampler doesn't read its environment again. A process the sampler never saw inside the tree counts only when its environment has the tag. The tag scan runs once for the whole machine, and every session reads its result through `owner-state.json`.

## Limits

- A reparented process that starts and exits between two samples loses its CPU, bounded by one 30-second interval.
- The sampler loses a child whose session parent left the table before reaping it, because that parent's reaped total cannot say which child it covers. The alternative would count a child twice whenever the parent did reap it.
- Hardened or SIP-protected binaries hide their environment, so the tag inside such a process is invisible. Tree membership still attributes the process while it remains inside the tree.
- A process that runs `env -i` drops the tag.
- Container CPU reaches the ledger through compose labels. A stack started outside the session's cwd goes unsampled. A stack that keeps running while its session is idle counts for the session only until the idle began, and the reader's snapshots record the rest as unowned.
- A daemon that starts while the session is idle, such as a double-forked background server, shows up in the next sample. Its counter is cumulative, so no CPU goes missing. The one exception is a process that starts and exits entirely inside a pause, with no child the check could see.
- macOS system daemons that work on the session's behalf (Spotlight indexing, XProtect) belong to no session, so no ledger records them.
- The machine-wide pass runs inside the owner session's process, so that session's `agent_cpu_s` includes the pass. Every record of a tick states the cost in `sample_cpu_s`.
- A contender takes over after 90 seconds without a new beat, so a hung owner costs the machine at most 90 seconds of sampling.
- A client that stays silent past 120 seconds, as after a machine sleep, is skipped until it registers again. Its saved state waits for it, and the owner drops a client silent for an hour.

## Privacy

A sample lists the session's processes with a name and a pid each, and reports CPU seconds for the agent, the descendants, the tagged strays, and each Docker stack. The sampler doesn't record command lines, environment values beyond the tag, or file contents. The sampler drops command lines and every environment value except the tag variable. It never reads file contents.

The shared files record each session's tag, pids, and working directory. They don't record anything else.
