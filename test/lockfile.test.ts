import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	LOCK_STALE_MS,
	heartbeat,
	isOwner,
	readLock,
	release,
	tryAcquire,
	type LockIdentity,
	type LockRecord,
} from "../src/lockfile.js";
import { cachePaths } from "../src/registry.js";

const NOW = 1_700_000_000_000;

function tempPaths() {
	const root = mkdtempSync(join(tmpdir(), "cpu-sample-lock-"));
	return { root, paths: cachePaths(root) };
}

function identity(pid: number, token: string): LockIdentity {
	return { pid, key: "pi-a", token };
}

/** Write a lock file directly, as a dead or hung owner would leave it. */
function plant(paths: ReturnType<typeof cachePaths>, lock: LockRecord): void {
	writeFileSync(paths.lockFile, JSON.stringify(lock));
}

const deadPid = 999_999;

describe("tryAcquire", () => {
	it("acquires a free lock and records the owner", () => {
		const { root, paths } = tempPaths();
		try {
			assert.equal(tryAcquire(paths, identity(process.pid, "tok-a"), NOW), true);
			const lock = readLock(paths);
			assert.equal(lock?.pid, process.pid);
			assert.equal(lock?.token, "tok-a");
			assert.equal(lock?.beat, NOW);
			assert.equal(lock?.key, "pi-a");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses a lock held by a live, recent owner", () => {
		const { root, paths } = tempPaths();
		try {
			assert.equal(tryAcquire(paths, identity(process.pid, "tok-a"), NOW), true);
			assert.equal(tryAcquire(paths, identity(process.pid, "tok-b"), NOW + 1_000), false);
			assert.equal(readLock(paths)?.token, "tok-a");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("takes over a lock whose owner process is gone", () => {
		const { root, paths } = tempPaths();
		try {
			plant(paths, { v: 1, pid: deadPid, key: "pi-a", token: "dead", beat: NOW });
			assert.equal(tryAcquire(paths, identity(process.pid, "tok-b"), NOW + 1_000), true);
			assert.equal(readLock(paths)?.token, "tok-b");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("takes over a lock whose beat is older than the stale window", () => {
		const { root, paths } = tempPaths();
		try {
			// The process is alive but stopped ticking: a hung owner must not
			// block takeover forever.
			plant(paths, { v: 1, pid: process.pid, key: "pi-a", token: "hung", beat: NOW - LOCK_STALE_MS - 1 });
			assert.equal(tryAcquire(paths, identity(process.ppid, "tok-b"), NOW), true);
			assert.equal(readLock(paths)?.token, "tok-b");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("lets exactly one of two contenders win a stale lock", () => {
		const { root, paths } = tempPaths();
		try {
			plant(paths, { v: 1, pid: deadPid, key: "pi-a", token: "dead", beat: NOW });
			const a = tryAcquire(paths, identity(process.pid, "tok-a"), NOW + 1_000);
			const b = tryAcquire(paths, identity(process.ppid, "tok-b"), NOW + 1_000);
			assert.equal(a, true);
			assert.equal(b, false);
			assert.equal(readLock(paths)?.token, "tok-a");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("leaves no claim file after a takeover", () => {
		const { root, paths } = tempPaths();
		try {
			plant(paths, { v: 1, pid: deadPid, key: "pi-a", token: "dead", beat: NOW });
			tryAcquire(paths, identity(process.pid, "tok-b"), NOW + 1_000);
			assert.deepEqual(
				readdirSync(paths.root).filter((n) => n.includes("claim")),
				[],
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("heartbeat and ownership", () => {
	it("renews the beat only for the current owner", () => {
		const { root, paths } = tempPaths();
		try {
			tryAcquire(paths, identity(process.pid, "tok-a"), NOW);
			assert.equal(heartbeat(paths, identity(process.pid, "tok-a"), NOW + 30_000), true);
			assert.equal(readLock(paths)?.beat, NOW + 30_000);
			assert.equal(heartbeat(paths, identity(process.pid, "tok-b"), NOW + 60_000), false);
			assert.equal(readLock(paths)?.beat, NOW + 30_000);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports ownership by token", () => {
		const { root, paths } = tempPaths();
		try {
			assert.equal(isOwner(paths, "tok-a"), false);
			tryAcquire(paths, identity(process.pid, "tok-a"), NOW);
			assert.equal(isOwner(paths, "tok-a"), true);
			assert.equal(isOwner(paths, "tok-b"), false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("release", () => {
	it("removes the lock for its token", () => {
		const { root, paths } = tempPaths();
		try {
			tryAcquire(paths, identity(process.pid, "tok-a"), NOW);
			release(paths, "tok-a");
			assert.equal(readLock(paths), null);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("never removes another owner's lock", () => {
		const { root, paths } = tempPaths();
		try {
			tryAcquire(paths, identity(process.pid, "tok-a"), NOW);
			release(paths, "tok-stale");
			assert.equal(readLock(paths)?.token, "tok-a");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("tolerates a lock that is already gone", () => {
		const { root, paths } = tempPaths();
		try {
			release(paths, "tok-a");
			assert.equal(readLock(paths), null);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("lock file hygiene", () => {
	it("leaves no temporary file after a successful create", () => {
		const { root, paths } = tempPaths();
		try {
			tryAcquire(paths, identity(process.pid, "tok-a"), NOW);
			assert.deepEqual(
				readdirSync(paths.root).filter((n) => n.startsWith("owner.lock.new-")),
				[],
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
