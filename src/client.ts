/**
 * The session client: what a pi session or a Claude Code sampler runs.
 *
 * Every tick it refreshes its registration, then acts on the owner lock. With
 * the lock it samples the whole machine through the owner. Without it, it
 * checks whether the lock is free or stale, takes over when it can, and reads
 * the result another owner wrote for it. Either way it appends each new record
 * to its own session store exactly once.
 *
 * A turn start publishes the registration at once and nudges the owner with
 * SIGURG, whose default action is to ignore the signal, so a wake sample does
 * not wait for the next owner tick. The 30-second cadence covers every signal
 * that does not arrive.
 *
 * A session whose cache directory cannot be used runs the in-process sampler
 * instead, so recording never depends on the shared files.
 */

import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { isOwner, lockIsStale, newToken, processAlive, readLock, release, tryAcquire } from "./lockfile.js";
import { Owner } from "./owner.js";
import {
	keyFor,
	readEntry,
	readResult,
	removeEntry,
	removeResult,
	writeEntry,
	type CachePaths,
	type RegistryEntry,
} from "./registry.js";
import { serialQueue } from "./pacer.js";
import type { RawDockerSnapshot } from "./ledger.js";
import type { ProcTable, SampleRecord } from "./types.js";

/** What the extension drives: one timer tick, one wake, one teardown. */
export interface SessionDriver {
	tick(): Promise<void>;
	wake(): void;
	stop(): Promise<void>;
	readonly isStopped: boolean;
}

export interface ClientIdentity {
	/** `pi:<session id>` or `claude:<session id>`. */
	session: string;
	agent: "pi" | "claude";
	/** The agent process whose tree the session owns. */
	agentPid: number;
	/** The process that runs this client: the pi process or the detached sampler. */
	clientPid: number;
	cwd: string;
}

export interface SharedClientOptions {
	paths: CachePaths;
	identity: ClientIdentity;
	table: ProcTable;
	docker: () => Promise<RawDockerSnapshot>;
	/** Append one record to the session's own store. */
	deliver: (record: SampleRecord) => void;
	/** True while a turn is in progress. */
	inTurn: () => boolean;
	/** False while sampling is switched off; the timer keeps running. */
	enabled?: () => boolean;
	log?: (message: string) => void;
	now?: () => number;
	isAlive?: (pid: number) => boolean;
	token?: string;
}

export class SharedClient implements SessionDriver {
	readonly key: string;
	readonly token: string;
	private owner: Owner | null = null;
	private deliveredRun: string | null = null;
	private deliveredSeq = -1;
	private stopped = false;
	private readonly enqueue: (work: () => Promise<void>) => Promise<void>;
	private readonly now: () => number;
	private readonly isAlive: (pid: number) => boolean;
	private readonly log: (message: string) => void;

	constructor(private opts: SharedClientOptions) {
		this.key = keyFor(opts.identity.session);
		this.token = opts.token ?? newToken();
		this.now = opts.now ?? Date.now;
		this.isAlive = opts.isAlive ?? processAlive;
		this.log = opts.log ?? (() => {});
		this.enqueue = serialQueue(this.log);
		ensureWritable(opts.paths);
		// A client that restarts for the same session continues where the last
		// one stopped delivering.
		const entry = readEntry(opts.paths, this.key);
		if (entry) {
			this.deliveredRun = entry.deliveredRun;
			this.deliveredSeq = entry.deliveredSeq;
		}
	}

	get isStopped(): boolean {
		return this.stopped;
	}

	/** One timer tick: register, lead or follow, deliver what is new. */
	tick(): Promise<void> {
		return this.enqueue(() => this.step());
	}

	/**
	 * A turn started. Publish the registration now, nudge the owner if another
	 * process holds the lock, and sample this session without waiting a tick.
	 */
	wake(): void {
		if (this.stopped) return;
		try {
			this.writeEntry(this.opts.inTurn());
		} catch (err) {
			this.log(`registration failed: ${message(err)}`);
		}
		const lock = readLock(this.opts.paths);
		if (lock !== null && lock.pid !== this.opts.identity.clientPid) {
			try {
				// SIGURG's default action is to ignore the signal, so a stale pid
				// that now names another process costs nothing.
				process.kill(lock.pid, "SIGURG");
			} catch {
				// The owner is gone between the read and the signal. The tick below
				// takes over.
			}
		}
		void this.tick();
	}

	/** Teardown: write the final record, then remove the session's files. */
	stop(): Promise<void> {
		this.stopped = true;
		return this.enqueue(() => this.teardown());
	}

	private async step(): Promise<void> {
		if (this.stopped) return;
		const { paths, identity } = this.opts;
		const now = this.now();
		if (!this.enabled()) {
			// Stop heartbeating so the machine goes on without this session, and
			// give the lock back if this process holds it.
			if (isOwner(paths, this.token)) release(paths, this.token);
			removeEntry(paths, this.key);
			return;
		}
		this.writeEntry(this.opts.inTurn());
		const lock = readLock(paths);
		if (lock !== null && lock.token === this.token) {
			await this.lead();
			return;
		}
		if (lock === null || lockIsStale(lock, now, this.isAlive)) {
			if (tryAcquire(paths, { pid: identity.clientPid, key: this.key, token: this.token }, now, this.isAlive)) {
				await this.lead();
				return;
			}
		}
		// A live owner runs the machine pass. Deliver what it wrote for us.
		this.deliverOwn();
	}

	/** Sample every registered session, then deliver this one's record. */
	private async lead(): Promise<void> {
		if (this.owner === null) {
			this.owner = new Owner({
				paths: this.opts.paths,
				table: this.opts.table,
				docker: this.opts.docker,
				identity: { pid: this.opts.identity.clientPid, key: this.key, token: this.token },
				log: this.log,
				now: this.now,
				isAlive: this.isAlive,
			});
		}
		const result = await this.owner.pass();
		if (result.kind === "not-owner") {
			// Another process owns the machine now. Drop this owner's accounts so
			// the next takeover restores their state from the result files.
			this.owner = null;
		}
		this.deliverOwn();
	}

	/** Append the session's newest result once, in run and seq order. */
	private deliverOwn(): void {
		const result = readResult(this.opts.paths, this.key);
		if (result === null) return;
		if (result.run === this.deliveredRun && result.seq <= this.deliveredSeq) return;
		try {
			this.opts.deliver(result.record);
			this.deliveredRun = result.run;
			this.deliveredSeq = result.seq;
			this.writeEntry(this.opts.inTurn());
		} catch (err) {
			this.log(`deliver failed: ${message(err)}`);
		}
	}

	private async teardown(): Promise<void> {
		const { paths, identity } = this.opts;
		try {
			if (this.enabled()) {
				// The same owner object keeps the machine state and the account; a
				// contender builds one only to read its saved state.
				const owner = this.owner ?? this.newOwner();
				await owner.finalize(this.key);
				this.deliverOwn();
			}
		} catch (err) {
			this.log(`final sample failed: ${message(err)}`);
		} finally {
			removeEntry(paths, this.key);
			removeResult(paths, this.key);
			if (isOwner(paths, this.token)) release(paths, this.token);
			this.owner = null;
		}
	}

	private newOwner(): Owner {
		return new Owner({
			paths: this.opts.paths,
			table: this.opts.table,
			docker: this.opts.docker,
			identity: { pid: this.opts.identity.clientPid, key: this.key, token: this.token },
			log: this.log,
			now: this.now,
			isAlive: this.isAlive,
		});
	}

	private writeEntry(busy: boolean): void {
		const { identity } = this.opts;
		const entry: RegistryEntry = {
			v: 1,
			key: this.key,
			session: identity.session,
			agent: identity.agent,
			agentPid: identity.agentPid,
			clientPid: identity.clientPid,
			cwd: identity.cwd,
			busy,
			beat: this.now(),
			deliveredRun: this.deliveredRun,
			deliveredSeq: this.deliveredSeq,
		};
		writeEntry(this.opts.paths, entry);
	}

	private enabled(): boolean {
		return this.opts.enabled?.() ?? true;
	}

}

/** The in-process sampler behind the same interface, for a broken cache dir. */
export class StandaloneSession implements SessionDriver {
	constructor(private pacer: PacerLike) {}

	tick(): Promise<void> {
		return this.pacer.tick();
	}

	wake(): void {
		void this.pacer.wake();
	}

	stop(): Promise<void> {
		return this.pacer.stop();
	}

	get isStopped(): boolean {
		return this.pacer.isStopped;
	}
}

/** The Pacer the standalone driver wraps, kept loose to avoid an import cycle. */
export interface PacerLike {
	tick(): Promise<void>;
	wake(): Promise<void>;
	stop(): Promise<void>;
	readonly isStopped: boolean;
}

/**
 * The shared client, or the in-process sampler when the cache directory cannot
 * be created or written.
 */
export function createSessionDriver(
	opts: SharedClientOptions & { standalone: () => SessionDriver },
): SessionDriver {
	try {
		return new SharedClient(opts);
	} catch (err) {
		opts.log?.(`shared sampler unavailable (${message(err)}); sampling in this process`);
		return opts.standalone();
	}
}

/** Fail fast when the cache directory cannot hold the registry. */
function ensureWritable(paths: CachePaths): void {
	mkdirSync(paths.registryDir, { recursive: true });
	mkdirSync(paths.resultsDir, { recursive: true });
	const probe = `${paths.root}/.probe-${process.pid}`;
	writeFileSync(probe, "");
	unlinkSync(probe);
}

function message(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}
