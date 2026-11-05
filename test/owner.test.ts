import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Owner } from "../src/owner.js";
import {
	cachePaths,
	readEntries,
	readOwnerState,
	readResult,
	writeEntry,
	writeResult,
	type RegistryEntry,
} from "../src/registry.js";
import { tryAcquire, type LockIdentity } from "../src/lockfile.js";
import type { RawDockerSnapshot } from "../src/ledger.js";
import type { ProcCpu, ProcRow, ProcTable } from "../src/types.js";

const NOW = 1_700_000_000_000;
const noDocker = async (): Promise<RawDockerSnapshot> => ({ ok: true, containers: [] });

class FakeTable implements ProcTable {
	rowsCalls = 0;
	envScans = 0;

	constructor(
		private rowsIn: ProcRow[],
		private usage: Map<number, ProcCpu>,
		private tags = new Map<number, string | null>(),
	) {}

	rows(): ProcRow[] | null {
		this.rowsCalls += 1;
		return this.rowsIn;
	}

	rusage(pid: number): ProcCpu | null {
		return this.usage.get(pid) ?? null;
	}

	readEnvTags(pids: number[]): Map<number, string | null> {
		this.envScans += 1;
		const out = new Map<number, string | null>();
		for (const pid of pids) out.set(pid, this.tags.get(pid) ?? null);
		return out;
	}

	childPids(pid: number): number[] {
		return this.rowsIn.filter((r) => r.ppid === pid).map((r) => r.pid);
	}

	row(pid: number): ProcRow | null {
		return this.rowsIn.find((r) => r.pid === pid) ?? null;
	}

	setUsage(pid: number, usage: ProcCpu): void {
		this.usage.set(pid, usage);
	}
}

function row(pid: number, ppid: number, opts: Partial<ProcRow> = {}): ProcRow {
	return { pid, ppid, uid: 501, comm: `p${pid}`, startSec: 1_700_000_000, startUsec: pid, ...opts };
}

function entry(session: string, patch: Partial<RegistryEntry> = {}): RegistryEntry {
	const key = session.replace(/:/g, "-");
	return {
		v: 1,
		key,
		session,
		agent: session.startsWith("pi:") ? "pi" : "claude",
		agentPid: 100,
		clientPid: 100,
		cwd: "/w",
		busy: true,
		beat: NOW,
		deliveredRun: null,
		deliveredSeq: -1,
		...patch,
	};
}

function tempPaths() {
	const root = mkdtempSync(join(tmpdir(), "cpu-sample-owner-"));
	return { root, paths: cachePaths(root) };
}

function identityOf(token: string): LockIdentity {
	return { pid: process.pid, key: "pi-s1", token };
}

/** An owner for the given paths that holds the lock. */
async function ownerFor(
	paths: ReturnType<typeof cachePaths>,
	table: ProcTable,
	token: string,
	now: () => number = () => NOW,
) {
	const identity = identityOf(token);
	assert.equal(tryAcquire(paths, identity, now()), true);
	return new Owner({
		paths,
		table,
		docker: noDocker,
		identity,
		now,
		isAlive: (pid) => pid === process.pid || pid === 100,
	});
}

describe("Owner.pass", () => {
	it("samples a busy session and writes its record with the run state", async () => {
		const { root, paths } = tempPaths();
		try {
			writeEntry(paths, entry("pi:s1"));
			const table = new FakeTable(
				[row(100, 0), row(101, 100)],
				new Map([
					[100, { own: 5, reaped: 0 }],
					[101, { own: 2, reaped: 0 }],
				]),
			);
			const owner = await ownerFor(paths, table, "tok-a");
			const result = await owner.pass();
			assert.equal(result.kind, "sampled");
			assert.deepEqual(result.keys, ["pi-s1"]);
			const saved = readResult(paths, "pi-s1");
			assert.equal(saved?.record.agentCpuS, 5);
			assert.equal(saved?.record.descendantCpuS, 2);
			assert.equal(saved?.record.v, 1);
			assert.equal(saved?.seq, 0);
			assert.equal(saved?.state.run, saved?.record.run);
			assert.equal(saved?.state.seq, 1);
			assert.equal(saved?.ownerPid, process.pid);
			assert.equal(saved?.final, false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("skips the full pass when every registered session is idle", async () => {
		const { root, paths } = tempPaths();
		try {
			writeEntry(paths, entry("pi:s1", { busy: false }));
			const table = new FakeTable(
				[
					[row(100, 0), row(101, 100)],
				].flat(),
				new Map([
					[100, { own: 5, reaped: 0 }],
					[101, { own: 2, reaped: 0 }],
				]),
			);
			const owner = await ownerFor(paths, table, "tok-a");
			// The first pass samples the baseline, the second brackets the pause,
			// and the third finds the session idle and reads nothing.
			await owner.pass();
			await owner.pass();
			const readsBefore = table.rowsCalls;
			const third = await owner.pass();
			assert.equal(third.kind, "idle");
			assert.equal(table.rowsCalls, readsBefore);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does nothing when the lock belongs to another owner", async () => {
		const { root, paths } = tempPaths();
		try {
			writeEntry(paths, entry("pi:s1"));
			// Another owner holds the lock.
			assert.equal(tryAcquire(paths, identityOf("other"), NOW), true);
			const table = new FakeTable([row(100, 0)], new Map());
			const owner = new Owner({
				paths,
				table,
				docker: noDocker,
				identity: identityOf("mine"),
				now: () => NOW,
				isAlive: () => true,
			});
			const result = await owner.pass();
			assert.equal(result.kind, "not-owner");
			assert.equal(readResult(paths, "pi-s1"), null);
			assert.equal(table.rowsCalls, 0);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("drops the registration of a session whose client is gone", async () => {
		const { root, paths } = tempPaths();
		try {
			writeEntry(paths, entry("pi:s1", { clientPid: 999_998 }));
			const table = new FakeTable([row(100, 0)], new Map());
			const owner = await ownerFor(paths, table, "tok-a");
			await owner.pass();
			assert.deepEqual(readEntries(paths), []);
			assert.equal(readResult(paths, "pi-s1"), null);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refreshes the lock beat", async () => {
		const { root, paths } = tempPaths();
		try {
			writeEntry(paths, entry("pi:s1", { busy: false }));
			const table = new FakeTable([row(100, 0)], new Map());
			let clock = NOW;
			const owner = await ownerFor(paths, table, "tok-a", () => clock);
			clock += 30_000;
			await owner.pass();
			const { readLock } = await import("../src/lockfile.js");
			assert.equal(readLock(paths)?.beat, clock);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes the owner state so the next owner reuses it", async () => {
		const { root, paths } = tempPaths();
		try {
			writeEntry(paths, entry("pi:s1"));
			const table = new FakeTable(
				[row(100, 0), row(300, 1)],
				new Map([
					[100, { own: 1, reaped: 0 }],
					[300, { own: 4, reaped: 0 }],
				]),
				new Map([[300, "pi:s1"]]),
			);
			const owner = await ownerFor(paths, table, "tok-a");
			await owner.pass();
			const state = readOwnerState(paths);
			assert.equal(state?.pid, process.pid);
			const tags = new Map(state?.tags);
			assert.equal(tags.get("300:1700000000:300"), "pi:s1");
			assert.equal(tags.get("100:1700000000:100"), null);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("Owner handover", () => {
	it("continues the same run and totals from the result file", async () => {
		const { root, paths } = tempPaths();
		try {
			writeEntry(paths, entry("pi:s1"));
			const table = new FakeTable(
				[row(100, 0), row(101, 100)],
				new Map([
					[100, { own: 5, reaped: 0 }],
					[101, { own: 2, reaped: 0 }],
				]),
			);
			const first = await ownerFor(paths, table, "tok-a");
			await first.pass();
			const before = readResult(paths, "pi-s1");
			const { release } = await import("../src/lockfile.js");
			release(paths, "tok-a");

			// A new owner process takes the lock and restores the state.
			let clock = NOW + 30_000;
			const second = await ownerFor(paths, table, "tok-b", () => clock);
			table.setUsage(100, { own: 6, reaped: 0 });
			table.setUsage(101, { own: 4, reaped: 0 });
			await second.pass();
			const after = readResult(paths, "pi-s1");
			assert.equal(after?.record.run, before?.record.run);
			assert.equal(after?.seq, 1);
			assert.equal(after?.record.agentCpuS, 6);
			assert.equal(after?.record.descendantCpuS, 4);
			assert.equal(after?.record.intervalS, 30);
			assert.equal(after?.state.seq, 2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("starts a new run when the result file is gone", async () => {
		const { root, paths } = tempPaths();
		try {
			writeEntry(paths, entry("pi:s1"));
			const table = new FakeTable([row(100, 0)], new Map([[100, { own: 3, reaped: 0 }]]));
			// A result file with no state for this session is not used.
			writeResult(paths, "other", {
				v: 1,
				key: "other",
				session: "pi:other",
				agent: "pi",
				agentPid: 100,
				cwd: "/w",
				ownerPid: process.pid,
				writtenAt: new Date(NOW).toISOString(),
				run: "old-run",
				seq: 9,
				final: false,
				record: {} as never,
				state: {
					run: "old-run",
					seq: 10,
					lastTs: NOW,
					ledger: {
						lastBuckets: { agent: 0, descendant: 0, taggedOrphan: 0 },
						bucketOf: [],
						lastTotal: [],
						lastParent: [],
					},
					everInTree: [],
					outsideTree: [],
					dockerSeen: [],
				},
			});
			const owner = await ownerFor(paths, table, "tok-a");
			await owner.pass();
			const saved = readResult(paths, "pi-s1");
			assert.equal(saved?.seq, 0);
			assert.notEqual(saved?.record.run, "old-run");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
