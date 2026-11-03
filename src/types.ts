/**
 * Data types shared by the sampler backends, the ledger, and the sample record.
 *
 * CPU values are seconds, cumulative since process (or container) start. A
 * sample never carries rates or deltas: the reader subtracts consecutive
 * samples, so a missed tick loses nothing.
 */

/** One row of the platform process table. */
export interface ProcRow {
	pid: number;
	ppid: number;
	uid: number;
	/** Kernel process name, truncated to the kernel's limit (16 chars on macOS). */
	comm: string;
	/** Process start time, whole seconds since the epoch. */
	startSec: number;
	/** Process start time, microseconds. */
	startUsec: number;
}

/** Cumulative CPU of one process: its own time, plus the time of descendants it reaped. */
export interface ProcCpu {
	own: number;
	reaped: number;
}

/** Identity of a process across pid reuse: pid plus start time. */
export interface ProcKey {
	pid: number;
	startSec: number;
	startUsec: number;
}

export function keyOf(row: ProcRow): string {
	return `${row.pid}:${row.startSec}:${row.startUsec}`;
}

/**
 * The platform process table. Everything the sampler needs from the operating
 * system, so the accounting logic can be tested against a fake table.
 */
export interface ProcTable {
	/** Every process on the machine, or null when the table cannot be read. */
	rows(): ProcRow[] | null;
	/** Cumulative CPU of one live process, or null when the process is gone or unreadable. */
	rusage(pid: number): ProcCpu | null;
	/**
	 * Read the CPU_SAMPLE_SESSION value from the initial environment of the
	 * given processes. Only the tag variable is interpreted; no other value is
	 * read or kept. Processes the platform will not expose (hardened runtime,
	 * other users) come back absent.
	 */
	readEnvTags(pids: number[]): Map<number, string | null>;
	/**
	 * The direct children of one process, or null when the platform cannot say.
	 * The sampler walks this upward from the agent; it costs one kernel call per
	 * process and never reads the whole table.
	 */
	childPids(pid: number): number[] | null;
	/**
	 * The single row for one live pid, or null when the process is gone. A pid
	 * whose start time differs from the recorded one is a different process.
	 */
	row(pid: number): ProcRow | null;
}

/** One running Docker compose stack under the session's working directory. */
export interface StackSample {
	/** The stack's com.docker.compose.project.working_dir. */
	dir: string;
	/** The stack's com.docker.compose.project. */
	project: string;
	/**
	 * Cumulative container CPU seconds for the stack within this sampler run:
	 * current counters plus the last value of every container that left.
	 */
	cpuS: number;
	/** Cumulative counter per container id, as the Engine API reports it. */
	containers: Record<string, number>;
}

export interface DockerSample {
	/** False when Docker is missing, stopped, or too slow to answer. */
	ok: boolean;
	stacks: StackSample[];
}

/** One sample as it lands in the pi session file or the Claude Code side file. */
export interface SampleRecord {
	v: 1;
	ts: string;
	/** Identifies one sampler lifetime: samples of one run share a baseline. */
	run: string;
	seq: number;
	agent: "pi" | "claude";
	/** The `<harness>:<session id>` value of CPU_SAMPLE_SESSION. */
	session: string;
	cwd: string;
	agentPid: number;
	/** Wall seconds since the previous sample of this run; null on the first. */
	intervalS: number | null;
	/** CPU the agent process itself used, cumulative. */
	agentCpuS: number;
	/** CPU of the agent's descendants: live tree members and time their parents reaped. */
	descendantCpuS: number;
	/** CPU of processes that carry the session tag but escaped the tree. */
	taggedOrphanCpuS: number;
	/** Live session processes, largest first. */
	procs: { name: string; pid: number; cpuS: number }[];
	procsTruncated: boolean;
	docker: DockerSample;
	/** Cumulative CPU of the Docker Desktop host processes (the VM and its helpers). */
	dockerVmCpuS: number;
	/** Changes whenever a Docker host process is replaced; deltas across a change are discarded. */
	dockerVmBoot: string | null;
	/** CPU the sampler itself spent taking this sample. */
	sampleCpuS: number;
	/** Wall time the sampler spent taking this sample. */
	sampleWallS: number;
}
