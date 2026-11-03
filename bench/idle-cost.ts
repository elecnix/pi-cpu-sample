/**
 * Cost of the idle check, which decides every 30 s whether a paused sampler
 * resumes. Numbers feed the README.
 *
 * Run with `npm run bench:idle`. Each "idle session" is an IdleTracker over a
 * process tree shaped like an idle Claude Code session: two quiet children,
 * which is what its MCP servers look like between turns. The child listing
 * costs one real `proc_listchildpids` call per process, the same work the
 * production probe does; only the rows and the CPU figures are synthetic, so
 * the number does not drift with this machine's process table. The full sample
 * runs the real sampler with Docker stubbed out, so it reports process-table
 * cost alone.
 */

import { MacOSTable } from "../src/macos.js";
import { IdleTracker, type IdleProbe } from "../src/idle.js";
import { Sampler } from "../src/sample.js";

const AGENT_PID = 424242;
const CHILDREN = [424243, 424244];

/** An idle session: two quiet children, no member outside the tree. */
class IdleSession implements IdleProbe {
	private rowCache = CHILDREN.map((pid) => ({
		pid,
		ppid: AGENT_PID,
		uid: -1,
		comm: "node",
		startSec: 1_700_000_000,
		startUsec: 0,
	}));
	constructor(private table: MacOSTable) {}

	/**
	 * The agent's children. The listing is a real `proc_listchildpids` call, so
	 * it costs what the production probe costs; the agent pid is synthetic, and
	 * the kernel answers zero children for a pid that does not exist, which is
	 * the shape of an idle session.
	 */
	descendants() {
		const listed = this.table.childPids(AGENT_PID);
		if (listed === null) return null;
		return listed.map((pid) => ({ key: `${pid}:1700000000:0`, pid, cpuS: 1.5 }));
	}
	trackedKeys(): Set<string> {
		return new Set();
	}
	cpuOf(): number {
		return 1.5;
	}
	row(pid: number) {
		return this.rowCache.find((r) => r.pid === pid) ?? null;
	}
}

/** CPU microseconds per call. process.cpuUsage() already reports microseconds. */
function cpuMicros(fn: () => void, iterations: number): number {
	for (let i = 0; i < Math.min(iterations, 1000); i++) fn();
	const before = process.cpuUsage();
	for (let i = 0; i < iterations; i++) fn();
	const after = process.cpuUsage(before);
	return (after.user + after.system) / iterations;
}

const TICKS_PER_HOUR = 3600 / 30;

function report(label: string, perTickUs: number): void {
	const perHourS = (perTickUs / 1e6) * TICKS_PER_HOUR;
	console.log(`${label.padEnd(30)} ${perTickUs.toFixed(1).padStart(8)} us/tick   ${perHourS.toFixed(4)} CPU-s/hour`);
}

const kernel = new MacOSTable();
if (kernel.childPids(process.pid) === null) throw new Error("kernel child listing unavailable");

const one = new IdleTracker(new IdleSession(kernel));
report("idle check, 1 session", cpuMicros(() => one.check(), 100_000));

const twenty = Array.from({ length: 20 }, () => new IdleTracker(new IdleSession(kernel)));
report(
	"idle check, 20 sessions",
	cpuMicros(() => {
		for (const t of twenty) t.check();
	}, 1000),
);

const sampler = new Sampler({
	table: kernel,
	docker: async () => ({ ok: false, containers: [] }),
	agentPid: process.pid,
	agent: "pi",
	session: "pi:bench",
	cwd: "/",
	runId: "bench",
	selfPid: -1,
});
const before = process.cpuUsage();
const N = 20;
for (let i = 0; i < N; i++) await sampler.tick();
const spent = process.cpuUsage(before);
const fullUs = (spent.user + spent.system) / N;
report("full sample (Docker stubbed)", fullUs);
