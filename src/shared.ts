/**
 * The machine-wide pass and the per-session accounting that runs on it.
 *
 * One process, the owner, reads the process table, scans the environment of
 * new candidate processes, reads Docker, and reads the Docker VM totals, once
 * per tick. It then walks each registered session's own tree. A session that
 * another process owns costs one index lookup per member, not a table read.
 *
 * The per-session accounting keeps the same cumulative rules as the standalone
 * sampler. `SessionAccount` carries that state, and it serialises to plain JSON
 * so a new owner continues the same run after a handover.
 */

import { randomUUID } from "node:crypto";
import { isUnder } from "./paths.js";
import {
	DockerLedger,
	ProcIndex,
	SessionLedger,
	outsideTreeKeys,
	type ContainerObs,
	type RawDockerSnapshot,
} from "./ledger.js";
import type { IdleProbe } from "./idle.js";
import { byDepth, descendantRows } from "./sample.js";
import { keyFor, type OwnerState, type SessionState } from "./registry.js";
import { keyOf, type ProcCpu, type ProcRow, type ProcTable, type SampleRecord } from "./types.js";

/** What one machine-wide read produced. */
export interface MachineObservation {
	rows: ProcRow[];
	index: ProcIndex;
	/** Cumulative CPU of every live process, read once. */
	usage: Map<number, ProcCpu>;
	dockerOk: boolean;
	/** Every running container Docker reported, whatever its working directory. */
	containers: ContainerObs[];
	vmCpuS: number;
	/** The Docker host process generation these totals belong to. */
	vmBoot: number | null;
	/** Keys whose cached tag equals this session. Dead keys are filtered later. */
	taggedKeysFor(session: string): Set<string>;
	atMs: number;
}

export interface MachinePassOptions {
	table: ProcTable;
	/** One read per tick, for every container on the machine. */
	docker: () => Promise<RawDockerSnapshot>;
	selfUid?: number;
}

const NO_KEYS: Set<string> = new Set();

/**
 * The machine-wide half of the sampler: the process table, the tag cache, the
 * Docker snapshot, and the Docker VM totals. The state survives an owner
 * change through `exportState` and `restore`.
 */
export class MachinePass {
	private tagCache = new Map<string, string | null>();
	/** Tag value to the keys that carry it, so a session never rescans the cache. */
	private tagged = new Map<string, Set<string>>();
	private vmSeen = new Map<string, number>();
	private vmBoot = 0;

	constructor(private opts: MachinePassOptions) {}

	/** Carry the tag cache and VM totals of the owner this process replaces. */
	restore(state: OwnerState | null): void {
		if (state === null) return;
		for (const [key, tag] of state.tags) {
			this.cacheTag(key, tag);
		}
		for (const [key, total] of state.vmSeen) this.vmSeen.set(key, total);
		this.vmBoot = state.vmBoot;
	}

	exportState(pid: number, nowMs: number): OwnerState {
		return {
			ts: nowMs,
			vmBoot: this.vmBoot,
			pid,
			v: 1,
			tags: [...this.tagCache],
			vmSeen: [...this.vmSeen],
		};
	}

	/**
	 * Read the machine once. `excludePids` lists the per-session instrumentation
	 * processes: their CPU is sampler cost, so the tag scan skips them.
	 */
	async observe(excludePids: Set<number> = new Set()): Promise<MachineObservation> {
		const table = this.opts.table;
		const rows = table.rows() ?? [];
		const index = ProcIndex.build(rows);
		const uid = this.opts.selfUid ?? process.getuid?.() ?? -1;

		// Tag detection: processes this user owns, outside every session tree,
		// whose environment was never read. The cache makes the scan happen once
		// per process for the whole machine, not once per session per tick.
		const candidates: number[] = [];
		for (const row of rows) {
			const key = keyOf(row);
			if (index.dockerHost.has(key) || row.uid !== uid || excludePids.has(row.pid)) continue;
			if (this.tagCache.has(key)) continue;
			candidates.push(row.pid);
		}
		if (candidates.length > 0) {
			const tags = table.readEnvTags(candidates);
			for (const pid of candidates) {
				const row = index.byPid.get(pid);
				if (!row) continue;
				// A process with no tag caches as null: it will never be a tagged
				// orphan, so its environment is never read again.
				this.cacheTag(keyOf(row), tags.get(pid) ?? null);
			}
		}

		// Parents first: a child that exits mid-pass is either gone from its own
		// read or already inside the parent's reaped total, never counted by both.
		const usage = new Map<number, ProcCpu>();
		for (const row of byDepth(rows)) {
			const ru = table.rusage(row.pid);
			if (ru) usage.set(row.pid, ru);
		}

		// Docker host processes: cumulative CPU of the VM and its helpers. A
		// helper that exits keeps its last total, so this number only grows until
		// the VM restarts. A restart shows as a live process whose counter went
		// backwards, or as host processes sharing no key with the last tick.
		let vmRawBoot = 0;
		const current = new Map<string, number>();
		for (const key of index.dockerHost) {
			const row = index.byKey.get(key);
			if (!row) continue;
			if (row.startSec > vmRawBoot) vmRawBoot = row.startSec;
			const ru = table.rusage(row.pid);
			if (ru) current.set(key, ru.own + ru.reaped);
		}
		const shared = [...current.keys()].filter((key) => this.vmSeen.has(key));
		const regressed = shared.some((key) => (current.get(key) ?? 0) < (this.vmSeen.get(key) ?? 0) - 1e-9);
		const replaced = this.vmSeen.size > 0 && current.size > 0 && shared.length === 0;
		if (this.vmSeen.size === 0 || regressed || replaced) {
			this.vmSeen.clear();
			this.vmBoot = vmRawBoot;
		}
		for (const [key, total] of current) this.vmSeen.set(key, total);
		let vmCpuS = 0;
		for (const total of this.vmSeen.values()) vmCpuS += total;

		let dockerOk = false;
		let containers: ContainerObs[] = [];
		try {
			const snap = await this.opts.docker();
			dockerOk = snap.ok;
			containers = snap.containers ?? [];
		} catch {
			dockerOk = false;
		}

		return {
			rows,
			index,
			usage,
			dockerOk,
			containers,
			vmCpuS,
			vmBoot: this.vmBoot > 0 ? this.vmBoot : null,
			taggedKeysFor: (session: string) => this.tagged.get(session) ?? NO_KEYS,
			atMs: Date.now(),
		};
	}

	private cacheTag(key: string, tag: string | null): void {
		this.tagCache.set(key, tag);
		if (tag === null) return;
		let keys = this.tagged.get(tag);
		if (!keys) {
			keys = new Set();
			this.tagged.set(tag, keys);
		}
		keys.add(key);
	}
}

/** One session's cumulative accounting state, owned by whichever process samples. */
export interface SessionAccount {
	key: string;
	session: string;
	agent: "pi" | "claude";
	agentPid: number;
	cwd: string;
	/**
	 * The session's instrumentation process, or -1 when the client is the agent
	 * itself. The record never counts that process.
	 */
	excludePid: number;
	runId: string;
	/** The seq the next record takes. */
	seq: number;
	/** Wall-clock milliseconds of the last record, or null before the first. */
	lastTs: number | null;
	everInTree: Set<string>;
	outsideTree: Set<string>;
	ledger: SessionLedger;
	dockerLedger: DockerLedger;
}

export interface SessionInit {
	session: string;
	agent: "pi" | "claude";
	agentPid: number;
	cwd: string;
	excludePid: number;
	key?: string;
	runId?: string;
	/** State a previous owner left behind; omitting it starts a new run. */
	state?: SessionState | null;
}

/**
 * A session's account. With saved state the same run and totals continue. With
 * none, a new run starts at seq 0 and the counters form a fresh baseline.
 */
export function sessionAccount(init: SessionInit): SessionAccount {
	const key = init.key ?? keyFor(init.session);
	if (init.state) {
		const everInTree = new Set(init.state.everInTree);
		return {
			key,
			session: init.session,
			agent: init.agent,
			agentPid: init.agentPid,
			cwd: init.cwd,
			excludePid: init.excludePid,
			runId: init.state.run,
			seq: init.state.seq,
			lastTs: init.state.lastTs,
			everInTree,
			outsideTree: new Set(init.state.outsideTree),
			ledger: SessionLedger.restore(init.agentPid, everInTree, init.state.ledger),
			dockerLedger: DockerLedger.restore(init.state.dockerSeen ?? []),
		};
	}
	const everInTree = new Set<string>();
	return {
		key,
		session: init.session,
		agent: init.agent,
		agentPid: init.agentPid,
		cwd: init.cwd,
		excludePid: init.excludePid,
		runId: init.runId ?? randomUUID(),
		seq: 0,
		lastTs: null,
		everInTree,
		outsideTree: new Set(),
		ledger: new SessionLedger(init.agentPid, everInTree),
		dockerLedger: new DockerLedger(),
	};
}

/** The account as plain JSON, for the result file a new owner continues from. */
export function exportAccountState(account: SessionAccount): SessionState {
	return {
		run: account.runId,
		seq: account.seq,
		lastTs: account.lastTs,
		ledger: account.ledger.exportState(),
		everInTree: [...account.everInTree],
		outsideTree: [...account.outsideTree],
		dockerSeen: account.dockerLedger.exportState(),
	};
}

/** What the pass spent on the whole machine, written into every record it produces. */
export interface PassCost {
	cpuS: number;
	wallS: number;
}

/**
 * One session's record, computed from a machine-wide observation. The account
 * advances: the ledgers grow, the seq increments, and the idle probe sees the
 * members that left the tree.
 */
export function sessionRecord(
	account: SessionAccount,
	obs: MachineObservation,
	cost: PassCost,
	nowMs: number,
): SampleRecord {
	const taggedKeys = obs.taggedKeysFor(account.session);
	const buckets = account.ledger.consume(obs.rows, taggedKeys, obs.usage, {
		index: obs.index,
		excludePid: account.excludePid,
	});
	account.outsideTree = outsideTreeKeys(obs.rows, account.agentPid, taggedKeys, account.everInTree, obs.index);
	const under = obs.containers.filter((c) => isUnder(c.dir, account.cwd));
	const docker = { ok: obs.dockerOk, stacks: account.dockerLedger.consume(under).stacks };
	const intervalS = account.lastTs === null ? null : (nowMs - account.lastTs) / 1000;
	account.lastTs = nowMs;
	const record: SampleRecord = {
		v: 1,
		ts: new Date(nowMs).toISOString(),
		run: account.runId,
		seq: account.seq,
		agent: account.agent,
		session: account.session,
		cwd: account.cwd,
		agentPid: account.agentPid,
		intervalS,
		agentCpuS: buckets.agentCpuS,
		descendantCpuS: buckets.descendantCpuS,
		taggedOrphanCpuS: buckets.taggedOrphanCpuS,
		procs: buckets.procs,
		procsTruncated: buckets.procsTruncated,
		docker,
		dockerVmCpuS: obs.vmCpuS,
		dockerVmBoot: obs.vmBoot === null ? null : String(obs.vmBoot),
		sampleCpuS: cost.cpuS,
		sampleWallS: cost.wallS,
	};
	account.seq += 1;
	return record;
}

/**
 * The idle probe for one session, read from its own tree. The walk starts at
 * the agent and stops at every process without children, so an idle session
 * costs one child listing per tree member.
 */
export class SessionProbe implements IdleProbe {
	constructor(
		private table: ProcTable,
		private account: Pick<SessionAccount, "agentPid" | "excludePid"> & { outsideTree: Set<string> },
	) {}

	descendants(): { key: string; pid: number; cpuS: number }[] | null {
		const rows = descendantRows(this.table, this.account.agentPid);
		if (rows === null) return null;
		const out: { key: string; pid: number; cpuS: number }[] = [];
		for (const row of rows) {
			if (row.pid === this.account.excludePid) continue;
			const ru = this.table.rusage(row.pid);
			out.push({ key: keyOf(row), pid: row.pid, cpuS: ru ? ru.own + ru.reaped : 0 });
		}
		return out;
	}

	trackedKeys(): Set<string> {
		return this.account.outsideTree;
	}

	row(pid: number): ProcRow | null {
		return this.table.row(pid);
	}
}
