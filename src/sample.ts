/**
 * One sampler tick: classify the process table, read rusage, read Docker, and
 * assemble the cumulative sample record.
 *
 * The sampler's own process (selfPid) is never a session member: it is
 * instrumentation, not session work.
 */

import { DockerLedger, SessionLedger, classify, type ContainerObs } from "./ledger.js";
import { keyOf } from "./types.js";
import type { DockerSample, ProcCpu, ProcTable, SampleRecord } from "./types.js";

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

export class Sampler {
	private seq = 0;
	private lastTs: number | null = null;
	private tagCache = new Map<string, string | null>(); // proc key -> tag value or null
	private everInTree = new Set<string>();
	private sessionLedger: SessionLedger;
	private dockerLedger = new DockerLedger();

	constructor(private opts: SamplerOptions) {
		this.sessionLedger = new SessionLedger(opts.agentPid, this.everInTree);
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

		const m = classify(rows, this.opts.agentPid, new Set());
		const dockerHostKeys = m.dockerHost;

		// Tag detection: only processes outside the tree and outside the Docker
		// host set, owned by this user, that this run has never classified.
		const candidates: number[] = [];
		for (const row of rows) {
			const key = keyOf(row);
			if (m.tree.has(key) || dockerHostKeys.has(key) || row.uid !== myUid) continue;
			if (this.everInTree.has(key)) continue; // membership carried from the tree
			if (row.pid === this.opts.selfPid) continue;
			if (!this.tagCache.has(key)) candidates.push(row.pid);
		}
		if (candidates.length > 0) {
			const tags = table.readEnvTags(candidates);
			for (const row of rows) {
				if (tags.has(row.pid)) this.tagCache.set(keyOf(row), tags.get(row.pid) ?? null);
			}
		}
		const taggedKeys = new Set<string>();
		for (const [key, tag] of this.tagCache) {
			if (tag === this.opts.session) taggedKeys.add(key);
		}

		const usage = new Map<number, ProcCpu>();
		for (const row of rows) {
			if (row.pid === this.opts.selfPid) continue;
			const ru = table.rusage(row.pid);
			if (ru) usage.set(row.pid, ru);
		}
		const buckets = this.sessionLedger.consume(rows, taggedKeys, usage);

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

function cpuNow(): number {
	const u = process.cpuUsage();
	return (u.user + u.system) / 1e6;
}
