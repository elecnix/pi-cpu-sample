/**
 * Session accounting over the process table.
 *
 * One sample's session total is the snapshot sum: every live session process
 * contributes its own cumulative CPU, and every live session process
 * contributes the CPU of the descendants it has reaped. Within one snapshot
 * each process's time is counted exactly once, because reaped time only
 * covers processes that have already left the table. The reader subtracts
 * consecutive samples, so the ledger only has to keep the sum from dipping.
 *
 * A member that exits is handled by who owned its exit. If its session parent
 * is alive, or was a session member when the sampler last saw the member, that
 * parent's reaped total carries the time and the member adds nothing. If
 * launchd owned it, nothing else records its time, so its last total is added
 * for the rest of the run. A floor on each bucket guards the totals in any
 * case the sampler cannot see.
 *
 * That floor is what holds a departed member's time. A process reaped by its
 * session parent leaves through the parent's reaped total, so the sum does not
 * dip and nothing is added twice. A process launchd owns leaves nothing behind,
 * so the bucket keeps its last total for the rest of the run.
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

/**
 * Session members that are not in the agent's tree: tagged orphans, and
 * processes that were in the tree and now sit outside it. A paused sampler
 * watches this set, because these are the processes it can no longer see.
 */
export function outsideTreeKeys(rows: ProcRow[], agentPid: number, taggedKeys: Set<string>, everInTree: Set<string>): Set<string> {
	const m = classify(rows, agentPid, taggedKeys);
	const keys = new Set<string>();
	for (const key of m.tagged) keys.add(key);
	for (const key of everInTree) {
		if (!m.tree.has(key) && !m.dockerHost.has(key) && m.rows.has(key)) keys.add(key);
	}
	return keys;
}

export class SessionLedger {
	/** The last reported bucket totals; each bucket only ever grows. */
	private lastBuckets = { agent: 0, descendant: 0, taggedOrphan: 0 };
	/** The last known total, reaped total and parent per key, for exits. */
	private lastTotal = new Map<string, number>();
	private lastReaped = new Map<string, number>();
	private lastParent = new Map<string, string | null>();

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
		const keyByPid = new Map<number, string>();
		for (const row of rows) keyByPid.set(row.pid, keyOf(row));
		for (const key of m.tree) this.everInTree.add(key);
		const sessionKeys = new Set<string>([...m.tree, ...this.everInTree, ...m.tagged]);
		for (const key of m.dockerHost) sessionKeys.delete(key);

		let agentCpuS = 0;
		let descendantCpuS = 0;
		let taggedOrphanCpuS = 0;
		const procs: { name: string; pid: number; cpuS: number }[] = [];
		// Departed members are visited too: their keys live on in lastTotal even
		// after the table and the tag set stop mentioning them.
		const visited = new Set<string>([...sessionKeys, ...this.lastTotal.keys()]);
		for (const key of visited) {
			const row = m.rows.get(key);
			if (!row) {
				// The member left the table. Add its last total only when no
				// session member owned the exit, because a session parent's
				// reaped total already holds that time.
				const departed = this.lastTotal.get(key);
				const parent = this.lastParent.get(key) ?? null;
				const parentIsMember = parent !== null && (this.everInTree.has(parent) || taggedKeys.has(parent));
				// A parent that is still alive will fold the exit into its reaped
				// total. A parent that left the table only holds the time if it had
				// already reaped it, which its last reaped total shows.
				const parentHasIt =
					parent !== null &&
					(m.rows.has(parent) || (this.lastReaped.get(parent) ?? 0) >= (departed ?? 0) - 1e-9);
				const ownedBySession = parentIsMember && parentHasIt;
				if (departed !== undefined && !ownedBySession) {
					if (taggedKeys.has(key) && !this.everInTree.has(key)) taggedOrphanCpuS += departed;
					else descendantCpuS += departed;
				}
				continue;
			}
			// A failed read adds nothing. The process either comes back on the next
			// tick, or another member's reaped total picked up its time, or the
			// bucket floor below holds the total.
			const ru = usage.get(row.pid) ?? null;
			const total = ru ? ru.own + ru.reaped : 0;
			const own = ru ? ru.own : 0;
			if (ru) {
				this.lastTotal.set(key, total);
				this.lastReaped.set(key, ru.reaped);
			}
			this.lastParent.set(key, keyByPid.get(row.ppid) ?? null);
			procs.push({ name: row.comm, pid: row.pid, cpuS: total });
			if (row.pid === this.agentPid) {
				agentCpuS += own;
				descendantCpuS += total - own;
			} else if (m.tagged.has(key) && !m.tree.has(key) && !this.everInTree.has(key)) {
				// A process that was ever a tree member stays in the descendant
				// bucket, because its earlier contribution is held by that
				// bucket's floor.
				taggedOrphanCpuS += total;
			} else {
				descendantCpuS += total;
			}
		}
		// Each bucket only grows, which guards the cases the carry cannot see,
		// such as a read that fails while a live member's total is lower.
		agentCpuS = Math.max(agentCpuS, this.lastBuckets.agent);
		descendantCpuS = Math.max(descendantCpuS, this.lastBuckets.descendant);
		taggedOrphanCpuS = Math.max(taggedOrphanCpuS, this.lastBuckets.taggedOrphan);
		this.lastBuckets = { agent: agentCpuS, descendant: descendantCpuS, taggedOrphan: taggedOrphanCpuS };
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

/** What a tick's Docker read returns. */
export interface RawDockerSnapshot {
	ok: boolean;
	containers: ContainerObs[];
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
