/**
 * The owner: the one process that samples for every registered session.
 *
 * Each tick it looks at the registrations, drops the ones whose client is gone,
 * and decides which sessions need a sample. When every session is idle it
 * reads nothing but the cheap idle checks. Otherwise it takes one machine-wide
 * observation and writes one result per session that needs it.
 *
 * The owner holds the lock itself; `pass` stands down as soon as another
 * process owns it. A process that is not the owner can still call `finalize`
 * to write a session's last record at teardown.
 */

import { IdleTracker } from "./idle.js";
import {
	heartbeat,
	isOwner,
	processAlive,
	type LockIdentity,
} from "./lockfile.js";
import {
	readEntries,
	readEntry,
	readOwnerState,
	readResult,
	removeEntry,
	removeResult,
	writeOwnerState,
	writeResult,
	type CachePaths,
	type RegistryEntry,
	type ResultFile,
} from "./registry.js";
import { MachinePass, SessionProbe, exportAccountState, sessionAccount, sessionRecord, type SessionAccount } from "./shared.js";
import type { RawDockerSnapshot } from "./ledger.js";
import type { ProcTable } from "./types.js";

/** How long a registration may stay unrefreshed, in ms, before its session is skipped. */
export const ENTRY_STALE_MS = 120_000;
/** How long the owner keeps the state of a silent client before dropping it. */
export const ENTRY_ABANDON_MS = 3_600_000;

export interface OwnerOptions {
	paths: CachePaths;
	table: ProcTable;
	docker: () => Promise<RawDockerSnapshot>;
	/** The lock identity this process claimed. */
	identity: LockIdentity;
	log?: (message: string) => void;
	now?: () => number;
	isAlive?: (pid: number) => boolean;
	staleEntryMs?: number;
	abandonEntryMs?: number;
}

export type PassKind = "sampled" | "idle" | "not-owner";

export interface PassResult {
	kind: PassKind;
	/** The sessions this pass wrote a result for. */
	keys: string[];
}

/** Where the record's idle boundary sits: the observation, not the file write. */
const ZERO_COST = { cpuS: 0, wallS: 0 };

export class Owner {
	private machine: MachinePass;
	private accounts = new Map<string, SessionAccount>();
	private trackers = new Map<string, IdleTracker>();
	/** True once a sample has been taken since the session was last idle. */
	private active = new Map<string, boolean>();
	private entries = new Map<string, RegistryEntry>();
	private readonly now: () => number;
	private readonly isAlive: (pid: number) => boolean;
	private readonly log: (message: string) => void;

	constructor(private opts: OwnerOptions) {
		this.now = opts.now ?? Date.now;
		this.isAlive = opts.isAlive ?? processAlive;
		this.log = opts.log ?? (() => {});
		this.machine = new MachinePass({ table: opts.table, docker: opts.docker });
		this.machine.restore(readOwnerState(opts.paths));
	}

	/** One owner tick over every registration. */
	async pass(): Promise<PassResult> {
		const { paths, identity } = this.opts;
		const now = this.now();
		if (!isOwner(paths, identity.token)) return { kind: "not-owner", keys: [] };
		if (!heartbeat(paths, identity, now)) return { kind: "not-owner", keys: [] };

		const live = this.refreshEntries(now);
		const due: string[] = [];
		const afterCheck = new Set<string>();
		for (const entry of live) {
			const tracker = this.trackers.get(entry.key);
			if (!tracker) continue;
			const verdict = tracker.check(now);
			// The pacer's rule: a busy session samples, and an idle session that was
			// sampling takes one last sample to close the interval.
			if (!verdict.idle) {
				due.push(entry.key);
				afterCheck.add(entry.key);
			} else if (this.active.get(entry.key) ?? true) {
				due.push(entry.key);
				this.active.set(entry.key, false);
			}
		}
		if (due.length === 0) return { kind: "idle", keys: [] };
		await this.sample(due, { afterCheck, final: false });
		return { kind: "sampled", keys: due };
	}

	/**
	 * Write one last record for the given sessions, marked final. Used at
	 * teardown, so it does not require ownership.
	 */
	async finalize(key: string): Promise<void> {
		if (!this.accounts.has(key)) {
			const entry = readEntry(this.opts.paths, key);
			if (entry === null) return;
			this.ensureAccount(entry);
		}
		await this.sample([key], { afterCheck: new Set(), final: true });
	}

	/** The account a session currently samples from, for tests and teardown. */
	account(key: string): SessionAccount | undefined {
		return this.accounts.get(key);
	}

	/**
	 * Drop registrations whose client is gone or silent, and keep one account
	 * per live registration. A returning session restores its result state, so
	 * an owner change keeps the run and totals; a session that never had one
	 * starts a new run.
	 */
	private refreshEntries(now: number): RegistryEntry[] {
		const { paths } = this.opts;
		const staleAfter = this.opts.staleEntryMs ?? ENTRY_STALE_MS;
		const abandonAfter = this.opts.abandonEntryMs ?? ENTRY_ABANDON_MS;
		const live = new Map<string, RegistryEntry>();
		for (const entry of readEntries(paths)) {
			const silentMs = now - entry.beat;
			if (!this.isAlive(entry.clientPid) || silentMs > abandonAfter) {
				removeEntry(paths, entry.key);
				removeResult(paths, entry.key);
				this.forget(entry.key);
				this.log(`dropped ${entry.session}`);
				continue;
			}
			if (silentMs > staleAfter) {
				// The machine slept, or the client is blocked. Nothing ran while it
				// was silent, so sample nothing and keep its saved state. The next
				// registration continues the same run.
				this.forget(entry.key);
				continue;
			}
			live.set(entry.key, entry);
		}
		this.entries = live;
		for (const key of [...this.accounts.keys()]) {
			if (!live.has(key)) this.forget(key);
		}
		for (const entry of live.values()) {
			const account = this.accounts.get(entry.key);
			if (
				account !== undefined &&
				(account.agentPid !== entry.agentPid || account.excludePid !== excludePidFor(entry) || account.cwd !== entry.cwd)
			) {
				// The same session key came back under a new process. It is a new
				// session instance, so it starts a new run: keeping the old ledger
				// would count the old tree's totals inside the new one.
				this.forget(entry.key);
				removeResult(paths, entry.key);
			}
			if (!this.accounts.has(entry.key)) this.ensureAccount(entry);
		}
		return [...live.values()];
	}

	private ensureAccount(entry: RegistryEntry): SessionAccount {
		const saved = readResult(this.opts.paths, entry.key);
		// Saved accounting belongs to the process that wrote it. A session key
		// that now names a different agent or client starts a new run instead of
		// inheriting totals from a tree it never walked. A result written before
		// the clientPid field existed can only be checked by agent and cwd.
		const sameProcess =
			saved !== null &&
			saved.agentPid === entry.agentPid &&
			(saved.clientPid === undefined || saved.clientPid === entry.clientPid) &&
			saved.cwd === entry.cwd;
		const state = sameProcess ? saved.state : null;
		const account = sessionAccount({
			session: entry.session,
			agent: entry.agent,
			agentPid: entry.agentPid,
			cwd: entry.cwd,
			excludePid: excludePidFor(entry),
			key: entry.key,
			state,
		});
		this.accounts.set(entry.key, account);
		this.trackers.set(
			entry.key,
			new IdleTracker(new SessionProbe(this.opts.table, account), () => this.entries.get(entry.key)?.busy ?? false),
		);
		return account;
	}

	private forget(key: string): void {
		this.accounts.delete(key);
		this.trackers.delete(key);
		this.active.delete(key);
	}

	/** One machine-wide observation, then one result per session that needs it. */
	private async sample(
		keys: string[],
		opts: { afterCheck: Set<string>; final: boolean },
	): Promise<void> {
		const { paths, identity } = this.opts;
		const startedCpu = cpuNow();
		const startedWall = performance.now();
		const exclude = new Set<number>();
		for (const key of keys) {
			const account = this.accounts.get(key);
			if (account && account.excludePid > 0) exclude.add(account.excludePid);
		}
		const obs = await this.machine.observe(exclude);
		const atMs = this.now();

		const batches: { key: string; account: SessionAccount; records: import("./types.js").SampleRecord[] }[] = [];
		for (const key of keys) {
			const account = this.accounts.get(key);
			if (!account) continue;
			const records = [sessionRecord(account, obs, ZERO_COST, atMs)];
			if (opts.afterCheck.has(key)) {
				// The turn may have ended during the sample. One more cumulative
				// record starts the idle gap at the moment the work stopped.
				const tracker = this.trackers.get(key);
				const after = tracker?.check(atMs) ?? { idle: false, reason: "" };
				if (after.idle) records.push(sessionRecord(account, obs, ZERO_COST, atMs));
				this.active.set(key, !after.idle);
			} else if (opts.final) {
				this.active.set(key, false);
			}
			batches.push({ key, account, records });
		}

		// What the tick cost the owner: the machine-wide read and the accounts.
		// Every record of this tick carries the same figure.
		const cost = { cpuS: Math.max(0, cpuNow() - startedCpu), wallS: (performance.now() - startedWall) / 1000 };
		for (const batch of batches) {
			for (const record of batch.records) {
				record.sampleCpuS = cost.cpuS;
				record.sampleWallS = cost.wallS;
			}
			const last = batch.records[batch.records.length - 1]!;
			const result: ResultFile = {
				v: 1,
				key: batch.key,
				session: batch.account.session,
				agent: batch.account.agent,
				agentPid: batch.account.agentPid,
				clientPid: batch.account.excludePid === -1 ? batch.account.agentPid : batch.account.excludePid,
				cwd: batch.account.cwd,
				ownerPid: identity.pid,
				writtenAt: new Date(atMs).toISOString(),
				run: last.run,
				seq: last.seq,
				final: opts.final,
				record: last,
				state: exportAccountState(batch.account),
			};
			writeResult(paths, batch.key, result);
		}
		writeOwnerState(paths, this.machine.exportState(identity.pid, this.now()));
	}
}

/** The session's instrumentation pid, or -1 when the client is the agent itself. */
function excludePidFor(entry: RegistryEntry): number {
	return entry.clientPid === entry.agentPid ? -1 : entry.clientPid;
}

function cpuNow(): number {
	const u = process.cpuUsage();
	return (u.user + u.system) / 1e6;
}
