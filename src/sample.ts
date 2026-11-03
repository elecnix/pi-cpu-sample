/**
 * One sampler tick: classify the process table, read rusage, read Docker, and
 * assemble the cumulative sample record.
 *
 * A sampler that runs in its own process (selfPid) is instrumentation, not
 * session work, so the session never counts it. An in-process sampler passes
 * the agent pid as selfPid; the agent is the session's main number, so that
 * case keeps the agent in the ledger.
 */

import { DockerLedger, SessionLedger, classify, outsideTreeKeys, type ContainerObs } from "./ledger.js";
import { keyOf } from "./types.js";
import type { IdleProbe } from "./idle.js";
import type { DockerSample, ProcCpu, ProcRow, ProcTable, SampleRecord } from "./types.js";

export interface SamplerOptions {
	table: ProcTable;
	/** Returns the Docker snapshot for one tick; tick() catches anything it throws. */
	docker: () => Promise<{ ok: boolean; containers: ContainerObs[] }>;
	agentPid: number;
	agent: "pi" | "claude";
	session: string;
	cwd: string;
	runId: string;
	/** The sampler's own pid, excluded from the session. */
	selfPid: number;
	/** The uid the session's processes belong to; defaults to this process's uid. */
	selfUid?: number;
}

export class Sampler implements IdleProbe {
	private seq = 0;
	private lastTs: number | null = null;
	private tagCache = new Map<string, string | null>(); // proc key -> tag value or null
	private everInTree = new Set<string>();
	private sessionLedger: SessionLedger;
	private dockerLedger = new DockerLedger();
	/** Session members outside the tree as of the last full sample. */
	private outsideTree = new Set<string>();

	constructor(private opts: SamplerOptions) {
		this.sessionLedger = new SessionLedger(opts.agentPid, this.everInTree);
	}

	/**
	 * The pid the session must not count: the sampler's own process. An
	 * in-process sampler shares the agent's pid, and the agent always counts,
	 * so that case excludes nothing.
	 */
	private exclusionPid(): number {
		return this.opts.selfPid === this.opts.agentPid ? -1 : this.opts.selfPid;
	}

	descendants(): { key: string; pid: number; cpuS: number }[] | null {
		const rows = descendantRows(this.opts.table, this.opts.agentPid);
		if (rows === null) return null;
		const excludePid = this.exclusionPid();
		const out: { key: string; pid: number; cpuS: number }[] = [];
		for (const row of rows) {
			if (row.pid === excludePid) continue;
			const ru = this.opts.table.rusage(row.pid);
			out.push({ key: keyOf(row), pid: row.pid, cpuS: ru ? ru.own + ru.reaped : 0 });
		}
		return out;
	}

	trackedKeys(): Set<string> {
		return this.outsideTree;
	}

	row(pid: number): ProcRow | null {
		return this.opts.table.row(pid);
	}

	/** Cumulative CPU of one live pid, 0 when it is gone. */
	cpuOf(pid: number): number {
		const ru = this.opts.table.rusage(pid);
		return ru ? ru.own + ru.reaped : 0;
	}

	/** Swap the process table, for tests that move a process between ticks. */
	replaceTable(table: ProcTable): void {
		this.opts.table = table;
	}

	async tick(): Promise<SampleRecord> {
		const startedCpu = cpuNow();
		const startedWall = performance.now();
		const table = this.opts.table;
		const rows = table.rows() ?? [];
		const myUid = this.opts.selfUid ?? process.getuid?.() ?? -1;

		const excludePid = this.exclusionPid();
		const m = classify(rows, this.opts.agentPid, new Set());
		const dockerHostKeys = m.dockerHost;

		// Tag detection: only processes outside the tree and outside the Docker
		// host set, owned by this user, that this run has never classified.
		const candidates: number[] = [];
		const candidateKeys = new Map<number, string>();
		for (const row of rows) {
			const key = keyOf(row);
			if (m.tree.has(key) || dockerHostKeys.has(key) || row.uid !== myUid) continue;
			if (this.everInTree.has(key)) continue; // membership carried from the tree
			if (row.pid === excludePid) continue;
			if (!this.tagCache.has(key)) {
				candidates.push(row.pid);
				candidateKeys.set(row.pid, key);
			}
		}
		if (candidates.length > 0) {
			const tags = table.readEnvTags(candidates);
			for (const pid of candidates) {
				// A process with no tag caches as null: it will never be a
				// tagged orphan, so its environment is never read again.
				this.tagCache.set(candidateKeys.get(pid)!, tags.get(pid) ?? null);
			}
		}
		const taggedKeys = new Set<string>();
		for (const [key, tag] of this.tagCache) {
			if (tag === this.opts.session) taggedKeys.add(key);
		}

		const usage = new Map<number, ProcCpu>();
		for (const row of rows) {
			if (row.pid === excludePid) continue;
			const ru = table.rusage(row.pid);
			if (ru) usage.set(row.pid, ru);
		}
		const buckets = this.sessionLedger.consume(rows, taggedKeys, usage);
		this.outsideTree = outsideTreeKeys(rows, this.opts.agentPid, taggedKeys, this.everInTree);

		// Docker host processes: cumulative CPU of the VM and its helpers.
		let vmCpuS = 0;
		let vmBoot = 0;
		for (const key of dockerHostKeys) {
			const row = m.rows.get(key);
			if (!row) continue;
			const ru = table.rusage(row.pid);
			if (ru) {
				vmCpuS += ru.own + ru.reaped;
				if (row.startSec > vmBoot) vmBoot = row.startSec;
			}
		}

		let docker: DockerSample;
		try {
			const snap = await this.opts.docker();
			const stacks = this.dockerLedger.consume(snap.containers ?? []).stacks;
			docker = { ok: snap.ok, stacks };
		} catch {
			docker = { ok: false, stacks: [] };
		}

		const now = Date.now();
		const intervalS = this.lastTs === null ? null : (now - this.lastTs) / 1000;
		this.lastTs = now;
		const sampleCpuS = Math.max(0, cpuNow() - startedCpu);
		const record: SampleRecord = {
			v: 1,
			ts: new Date(now).toISOString(),
			run: this.opts.runId,
			seq: this.seq,
			agent: this.opts.agent,
			session: this.opts.session,
			cwd: this.opts.cwd,
			agentPid: this.opts.agentPid,
			intervalS,
			agentCpuS: buckets.agentCpuS,
			descendantCpuS: buckets.descendantCpuS,
			taggedOrphanCpuS: buckets.taggedOrphanCpuS,
			procs: buckets.procs,
			procsTruncated: buckets.procsTruncated,
			docker,
			dockerVmCpuS: vmCpuS,
			dockerVmBoot: vmBoot > 0 ? String(vmBoot) : null,
			sampleCpuS,
			sampleWallS: (performance.now() - startedWall) / 1000,
		};
		this.seq += 1;
		return record;
	}
}

/**
 * The agent's live descendants, or null when a child list cannot be read.
 *
 * The walk starts at the agent and stops as soon as a process reports no
 * children, so an idle session costs one child listing, not one per process.
 * A null row ends that branch: a pid the kernel stopped between the listing and
 * the lookup has no children left to find.
 */
function descendantRows(table: ProcTable, agentPid: number): ProcRow[] | null {
	const out: ProcRow[] = [];
	const seen = new Set<number>([agentPid]);
	let level = table.childPids(agentPid);
	if (level === null) return null;
	while (level.length > 0) {
		const next: number[] = [];
		for (const pid of level) {
			if (seen.has(pid)) continue;
			seen.add(pid);
			const row = table.row(pid);
			if (!row) continue;
			out.push(row);
			const children = table.childPids(pid);
			if (children === null) return null;
			next.push(...children);
		}
		level = next;
	}
	return out;
}

function cpuNow(): number {
	const u = process.cpuUsage();
	return (u.user + u.system) / 1e6;
}
