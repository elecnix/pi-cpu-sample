/**
 * Session accounting over the process table.
 *
 * One sample's session total is the snapshot sum: every live session process
 * contributes its own cumulative CPU, and every live session process
 * contributes the CPU of the descendants it has reaped. Within one snapshot
 * each process's time is counted exactly once, because reaped time only
 * covers processes that have already left the table. The reader subtracts
 * consecutive samples, so the ledger only has to keep the sum from dipping:
 * a process whose rusage read fails carries its last known value forward,
 * and a process that has left the tree stays in the ledger if it was ever a
 * tree member.
 */

import { keyOf, type DockerSample, type ProcCpu, type ProcRow, type StackSample } from "./types.js";

/** Name prefixes of the Docker Desktop host processes (VM backend and helpers). */
export const DOCKER_PROC_PREFIXES = ["com.docker", "Docker"];

export interface Membership {
	tree: Set<string>;
	tagged: Set<string>;
	dockerHost: Set<string>;
	rows: Map<string, ProcRow>;
}

/**
 * Split the table into the session tree (processes whose parent chain reaches
 * the agent), processes already known to carry the session tag, and Docker
 * host processes. Tag membership is passed in because it comes from the env
 * reader's cache, not from the table.
 */
export function classify(rows: ProcRow[], agentPid: number, taggedKeys: Set<string>): Membership {
	const byPid = new Map<number, ProcRow>();
	const byKey = new Map<string, ProcRow>();
	const children = new Map<number, ProcRow[]>();
	for (const row of rows) {
		byPid.set(row.pid, row);
		byKey.set(keyOf(row), row);
		const list = children.get(row.ppid);
		if (list) list.push(row);
		else children.set(row.ppid, [row]);
	}
	const tree = new Set<string>();
	const stack: ProcRow[] = [];
	const agent = byPid.get(agentPid);
	if (agent) {
		stack.push(agent);
		tree.add(keyOf(agent));
	}
	while (stack.length > 0) {
		const parent = stack.pop()!;
		for (const child of children.get(parent.pid) ?? []) {
			const key = keyOf(child);
			if (!tree.has(key)) {
				tree.add(key);
				stack.push(child);
			}
		}
	}
	const dockerHost = new Set<string>();
	for (const row of rows) {
		if (DOCKER_PROC_PREFIXES.some((p) => row.comm.startsWith(p))) dockerHost.add(keyOf(row));
	}
	const tagged = new Set<string>();
	for (const key of taggedKeys) {
		if (tree.has(key) || dockerHost.has(key)) continue;
		if (byKey.has(key)) tagged.add(key);
	}
	return { tree, tagged, dockerHost, rows: byKey };
}

export interface Buckets {
	agentCpuS: number;
	descendantCpuS: number;
	taggedOrphanCpuS: number;
	procs: { name: string; pid: number; cpuS: number }[];
	procsTruncated: boolean;
}

const PROC_LIST_CAP = 64;

export class SessionLedger {
	/** Last known totals per key, for reads that fail this tick. */
	private lastTotal = new Map<string, number>();
	private lastOwn = new Map<string, number>();

	/**
	 * @param everInTree keys that were ever tree members; the caller keeps this
	 *   set across ticks so a process that leaves the tree stays in the session
	 */
	constructor(
		private agentPid: number,
		private everInTree: Set<string>,
	) {}

	consume(rows: ProcRow[], taggedKeys: Set<string>, usage: Map<number, ProcCpu>): Buckets {
		const m = classify(rows, this.agentPid, taggedKeys);
		for (const key of m.tree) this.everInTree.add(key);
		const sessionKeys = new Set<string>([...m.tree, ...this.everInTree, ...m.tagged]);
		for (const key of m.dockerHost) sessionKeys.delete(key);

		let agentCpuS = 0;
		let descendantCpuS = 0;
		let taggedOrphanCpuS = 0;
		const procs: { name: string; pid: number; cpuS: number }[] = [];
		for (const key of sessionKeys) {
			const row = m.rows.get(key);
			if (!row) continue;
			const ru = usage.get(row.pid) ?? null;
			let total: number;
			let own: number;
			if (ru) {
				total = ru.own + ru.reaped;
				own = ru.own;
				this.lastTotal.set(key, total);
				this.lastOwn.set(key, own);
			} else {
				total = this.lastTotal.get(key) ?? 0;
				own = this.lastOwn.get(key) ?? 0;
			}
			procs.push({ name: row.comm, pid: row.pid, cpuS: total });
			if (row.pid === this.agentPid) {
				agentCpuS += own;
				descendantCpuS += total - own;
			} else if (m.tagged.has(key) && !m.tree.has(key)) {
				taggedOrphanCpuS += total;
			} else {
				descendantCpuS += total;
			}
		}
		procs.sort((a, b) => b.cpuS - a.cpuS);
		return {
			agentCpuS,
			descendantCpuS,
			taggedOrphanCpuS,
			procs: procs.slice(0, PROC_LIST_CAP),
			procsTruncated: procs.length > PROC_LIST_CAP,
		};
	}
}

export interface ContainerObs {
	id: string;
	project: string;
	dir: string;
	cpuS: number;
}

/**
 * Per-run Docker container accounting: stack totals stay cumulative by
 * carrying the last value of every container that stopped reporting, and a
 * counter that drops is read as a container restart.
 */
export class DockerLedger {
	private seen = new Map<string, ContainerObs>();

	consume(obs: ContainerObs[]): DockerSample {
		for (const o of obs) this.seen.set(o.id, { ...o });
		const byStack = new Map<string, StackSample>();
		for (const o of this.seen.values()) {
			const k = `${o.dir}\u0000${o.project}`;
			let stack = byStack.get(k);
			if (!stack) {
				stack = { dir: o.dir, project: o.project, cpuS: 0, containers: {} };
				byStack.set(k, stack);
			}
			stack.cpuS += o.cpuS;
			if (obs.some((c) => c.id === o.id)) stack.containers[o.id] = o.cpuS;
		}
		return { ok: true, stacks: [...byStack.values()].sort((a, b) => a.dir.localeCompare(b.dir)) };
	}
}
