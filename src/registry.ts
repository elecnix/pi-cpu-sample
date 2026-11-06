/**
 * Shared state of the machine-wide sampler: one registry entry per session, one
 * result file per session, the owner lock, and the owner's machine-wide state.
 *
 * Every write is a temporary file plus a rename, because a client, the owner,
 * and a takeover candidate all read these files while another process writes
 * them. A reader that sees a temporary file ignores it; a reader that sees the
 * renamed one sees a complete document.
 *
 * Directory layout under `~/.cache/cpu-sample`:
 *
 * - `registry/<key>.json`: written by the session's own client each tick.
 * - `results/<key>.json`: written by the owner each sampled tick. It carries the
 *   record to deliver and the accounting state a new owner continues from.
 * - `owner.lock`: the ownership record (see `lockfile.ts`).
 * - `owner-state.json`: the machine-wide tag and Docker VM totals.
 */

import { mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import type { ContainerObs, LedgerState } from "./ledger.js";
import type { SampleRecord } from "./types.js";

export const STATE_VERSION = 1;

export interface CachePaths {
	root: string;
	registryDir: string;
	resultsDir: string;
	lockFile: string;
	ownerStateFile: string;
}

/** The cache directory with the home directory expanded. */
export function defaultCacheDir(home: string): string {
	return `${home}/.cache/cpu-sample`;
}

export function cachePaths(root: string): CachePaths {
	return {
		root,
		registryDir: `${root}/registry`,
		resultsDir: `${root}/results`,
		lockFile: `${root}/owner.lock`,
		ownerStateFile: `${root}/owner-state.json`,
	};
}

/**
 * A session tag turned into a filename: `pi:<id>` becomes `pi-<id>`. Keys are
 * flat, so a tag can never address a file outside the registry directory.
 */
export function keyFor(session: string): string {
	return session.replace(/[^A-Za-z0-9._-]/g, "-");
}

/** One session's registration, refreshed by its client every tick. */
export interface RegistryEntry {
	v: 1;
	key: string;
	/** `pi:<session id>` or `claude:<session id>`. */
	session: string;
	agent: "pi" | "claude";
	/** The agent process whose tree the session owns. */
	agentPid: number;
	/**
	 * The process that ticks for this session: the pi process itself, or the
	 * detached Claude sampler. When it differs from the agent, it is
	 * instrumentation and never counts toward the session.
	 */
	clientPid: number;
	cwd: string;
	/** True while a turn runs, as the client last saw it. */
	busy: boolean;
	/** Client wall clock, milliseconds since the epoch, of the last refresh. */
	beat: number;
	/** Identity of the last delivered record, so a restart does not replay. */
	deliveredRun: string | null;
	deliveredSeq: number;
}

/** The accounting state a new owner continues from without losing a total. */
export interface SessionState {
	run: string;
	/** The seq the next record takes. */
	seq: number;
	/** Wall-clock milliseconds of the last record, or null before the first. */
	lastTs: number | null;
	ledger: LedgerState;
	everInTree: string[];
	/** Session members outside the agent's tree as of the last pass. */
	outsideTree: string[];
	/** Containers the session's Docker ledger has seen. */
	dockerSeen: ContainerObs[];
}

/** What the owner writes for one session: the record to deliver, and its state. */
export interface ResultFile {
	v: 1;
	key: string;
	session: string;
	agent: "pi" | "claude";
	agentPid: number;
	/** The process that ticked for the session when this state was written. */
	clientPid: number;
	cwd: string;
	ownerPid: number;
	writtenAt: string;
	/** The run and seq of `record`. */
	run: string;
	seq: number;
	/** True when this is the session's last record, written at teardown. */
	final: boolean;
	record: SampleRecord;
	state: SessionState;
}

/** Machine-wide state that survives an owner change. */
export interface OwnerState {
	v: 1;
	pid: number;
	ts: number;
	/** Proc key to `CPU_SAMPLE_SESSION` value, or null when it carries no tag. */
	tags: [string, string | null][];
	/** Last cumulative CPU per Docker host process key. */
	vmSeen: [string, number][];
	vmBoot: number;
}

function ensureDir(dir: string): void {
	mkdirSync(dir, { recursive: true });
}

/** Write JSON so a reader sees either the old file or the new one, never half. */
function writeJson(path: string, value: unknown): void {
	const tmp = `${path}.tmp.${process.pid}`;
	writeFileSync(tmp, JSON.stringify(dataWithoutUndefined(value)));
	renameSync(tmp, path);
}

/** `JSON.stringify` drops undefined, but a map made by hand can still carry it. */
function dataWithoutUndefined(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

function readJson(path: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return null;
		const doc = parsed as Record<string, unknown>;
		return doc.v === STATE_VERSION ? doc : null;
	} catch {
		return null;
	}
}

function looksLikeEntry(doc: Record<string, unknown>): boolean {
	return (
		typeof doc.key === "string" &&
		typeof doc.session === "string" &&
		typeof doc.agentPid === "number" &&
		typeof doc.clientPid === "number" &&
		typeof doc.cwd === "string" &&
		typeof doc.busy === "boolean" &&
		typeof doc.beat === "number"
	);
}

export function writeEntry(paths: CachePaths, entry: RegistryEntry): void {
	ensureDir(paths.registryDir);
	writeJson(`${paths.registryDir}/${entry.key}.json`, entry);
}

export function readEntry(paths: CachePaths, key: string): RegistryEntry | null {
	const doc = readJson(`${paths.registryDir}/${key}.json`);
	if (doc === null || !looksLikeEntry(doc)) return null;
	return {
		...doc,
		deliveredRun: typeof doc.deliveredRun === "string" ? doc.deliveredRun : null,
		deliveredSeq: typeof doc.deliveredSeq === "number" ? doc.deliveredSeq : -1,
	} as unknown as RegistryEntry;
}

/** Every readable registration, in key order. Malformed files are skipped. */
export function readEntries(paths: CachePaths): RegistryEntry[] {
	let names: string[];
	try {
		names = readdirSync(paths.registryDir);
	} catch {
		return [];
	}
	const out: RegistryEntry[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const entry = readEntry(paths, name.slice(0, -".json".length));
		if (entry !== null) out.push(entry);
	}
	out.sort((a, b) => a.key.localeCompare(b.key));
	return out;
}

export function removeEntry(paths: CachePaths, key: string): void {
	removeIfPresent(`${paths.registryDir}/${key}.json`);
}

export function writeResult(paths: CachePaths, key: string, result: ResultFile): void {
	ensureDir(paths.resultsDir);
	writeJson(`${paths.resultsDir}/${key}.json`, result);
}

export function readResult(paths: CachePaths, key: string): ResultFile | null {
	const doc = readJson(`${paths.resultsDir}/${key}.json`);
	if (doc === null) return null;
	if (typeof doc.key !== "string" || typeof doc.run !== "string" || typeof doc.seq !== "number") return null;
	if (doc.record === null || typeof doc.record !== "object") return null;
	if (doc.state === null || typeof doc.state !== "object") return null;
	return doc as unknown as ResultFile;
}

export function removeResult(paths: CachePaths, key: string): void {
	removeIfPresent(`${paths.resultsDir}/${key}.json`);
}

export function writeOwnerState(paths: CachePaths, state: OwnerState): void {
	ensureDir(paths.root);
	writeJson(paths.ownerStateFile, state);
}

export function readOwnerState(paths: CachePaths): OwnerState | null {
	const doc = readJson(paths.ownerStateFile);
	if (doc === null) return null;
	if (!Array.isArray(doc.tags) || !Array.isArray(doc.vmSeen)) return null;
	return doc as unknown as OwnerState;
}

/** Remove a file that another process may already have removed. */
function removeIfPresent(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// ENOENT: another client or the owner got there first.
	}
}
