/**
 * The owner lock: exactly one registered session samples for every other one.
 *
 * The owner writes its record on acquiring and rewrites it each tick, so the
 * beat is a live signal. A contender reads the record each tick and takes over
 * when the owner's process is gone, or when its beat is older than
 * `LOCK_STALE_MS` (a hung owner must not keep the machine for itself).
 *
 * Takeover moves the current record aside with one rename, checks that the file
 * it captured is the stale record it judged, and only then creates its own. A
 * contender that loses that race sees the lock file already present and waits a
 * tick. A lock whose file cannot be created at all leaves the session able to
 * sample on its own (see the client's standalone fallback).
 */

import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import type { CachePaths } from "./registry.js";

export const LOCK_VERSION = 1;
/** How long a beat may stay unchanged before a contender takes the lock. */
export const LOCK_STALE_MS = 90_000;

export interface LockRecord {
	v: 1;
	/** The owner process. */
	pid: number;
	/** The session key the owner serves too. */
	key: string;
	/** Identity of this ownership, so a release never removes another owner's lock. */
	token: string;
	/** Owner wall clock, milliseconds since the epoch, of the last heartbeat. */
	beat: number;
}

/** The identity a client claims ownership with. */
export interface LockIdentity {
	pid: number;
	key: string;
	token: string;
}

export function newToken(): string {
	return `${process.pid}-${randomUUID()}`;
}

/** The current lock, or null when no owner holds one or the file is unreadable. */
export function readLock(paths: CachePaths): LockRecord | null {
	try {
		const parsed: unknown = JSON.parse(readLockText(paths));
		if (parsed === null || typeof parsed !== "object") return null;
		const doc = parsed as Record<string, unknown>;
		if (doc.v !== LOCK_VERSION) return null;
		if (typeof doc.pid !== "number" || typeof doc.token !== "string" || typeof doc.beat !== "number") return null;
		return {
			v: 1,
			pid: doc.pid,
			key: typeof doc.key === "string" ? doc.key : "",
			token: doc.token,
			beat: doc.beat,
		};
	} catch {
		return null;
	}
}

function readLockText(paths: CachePaths): string {
	return readFileSync(paths.lockFile, "utf8");
}

/**
 * Take ownership when the lock is free or stale, and report whether this
 * process now owns it.
 */
export function tryAcquire(
	paths: CachePaths,
	identity: LockIdentity,
	nowMs: number,
	isAlive: (pid: number) => boolean = processAlive,
): boolean {
	const current = readLock(paths);
	if (current !== null) {
		if (!lockIsStale(current, nowMs, isAlive)) return false;
		// Move the stale record aside. One rename wins; every other contender
		// finds the path empty afterwards and tries to create its own record.
		const captured = captureLock(paths, identity.token);
		if (captured !== null) {
			if (captured.record.token !== current.token) {
				// The file changed between the read and the capture: a live owner
				// replaced the stale one. Put its record back and wait.
				restoreLock(paths, captured.claim);
				return false;
			}
			// The stale record is confirmed: it has served its purpose.
			tryUnlink(captured.claim);
		}
	}
	return createLock(paths, identity, nowMs);
}

/** Rewrite the record with a fresh beat. False when another owner holds it. */
export function heartbeat(paths: CachePaths, identity: LockIdentity, nowMs: number): boolean {
	const current = readLock(paths);
	if (current === null || current.token !== identity.token) return false;
	writeLockFile(paths, { v: LOCK_VERSION, pid: identity.pid, key: identity.key, token: identity.token, beat: nowMs });
	return true;
}

export function isOwner(paths: CachePaths, token: string): boolean {
	return readLock(paths)?.token === token;
}

/**
 * Give up ownership. The record is moved aside first and inspected, so a lock
 * that a takeover candidate already replaced stays with its new owner.
 */
export function release(paths: CachePaths, token: string): void {
	const captured = captureLock(paths, token);
	if (captured === null) return;
	if (captured.record.token === token) {
		tryUnlink(captured.claim);
		return;
	}
	restoreLock(paths, captured.claim);
}

/** True when the owner's process is gone or its beat stopped advancing. */
export function lockIsStale(
	lock: LockRecord,
	nowMs: number,
	isAlive: (pid: number) => boolean = processAlive,
): boolean {
	if (!isAlive(lock.pid)) return true;
	return nowMs - lock.beat > LOCK_STALE_MS;
}

/** Create the record only when the path is empty. */
function createLock(paths: CachePaths, identity: LockIdentity, nowMs: number, tries = 0): boolean {
	const tmp = `${paths.lockFile}.new-${identity.token}`;
	writeLockFile(paths, { v: LOCK_VERSION, pid: identity.pid, key: identity.key, token: identity.token, beat: nowMs }, tmp);
	try {
		// link() fails with EEXIST when the path exists: an atomic create-if-absent
		// that never exposes a half-written record to a reader. The temporary name
		// and the lock share a directory, so they share a filesystem.
		linkSync(tmp, paths.lockFile);
		return true;
	} catch (err) {
		// ENOENT: a takeover candidate renamed the stale record aside between
		// the read and the link. The path is free again, so one retry decides.
		if ((err as NodeJS.ErrnoException).code === "ENOENT" && tries === 0) {
			return createLock(paths, identity, nowMs, tries + 1);
		}
		return false;
	} finally {
		// The record lives at the lock path now; the temporary name is spent.
		tryUnlink(tmp);
	}
}

/**
 * Move the lock file to a private name and return what it held. `link` would
 * not do here: the point is to remove the record from the shared path in the
 * same step the winner is decided.
 */
function captureLock(paths: CachePaths, tag: string): { record: LockRecord; claim: string } | null {
	const claim = `${paths.lockFile}.claim-${tag}`;
	try {
		renameSync(paths.lockFile, claim);
	} catch {
		return null;
	}
	const record = readLockFile(claim);
	if (record === null) {
		tryUnlink(claim);
		return null;
	}
	return { record, claim };
}

/** Put a captured record back, but never over a record created meanwhile. */
function restoreLock(paths: CachePaths, claim: string): void {
	try {
		linkSync(claim, paths.lockFile);
	} catch {
		// EEXIST: another owner already created its record. Ours is obsolete.
	}
	tryUnlink(claim);
}

function readLockFile(path: string): LockRecord | null {
	try {
		const doc = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
		if (doc.v !== LOCK_VERSION || typeof doc.pid !== "number" || typeof doc.token !== "string") return null;
		return { v: 1, pid: doc.pid, key: typeof doc.key === "string" ? doc.key : "", token: doc.token, beat: Number(doc.beat) };
	} catch {
		return null;
	}
}

function writeLockFile(paths: CachePaths, record: LockRecord, path: string = paths.lockFile): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(record));
}

function tryUnlink(path: string): void {
	try {
		unlinkSync(path);
	} catch {
		// Already gone: another contender or the owner removed it.
	}
}

/** True when the pid names a live process this user may signal. */
export function processAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// EPERM: the process exists and belongs to another user.
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}
