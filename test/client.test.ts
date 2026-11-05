import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SharedClient, createSessionDriver, type SessionDriver } from "../src/client.js";
import { cachePaths, readEntry, readResult } from "../src/registry.js";
import { readLock } from "../src/lockfile.js";
import type { RawDockerSnapshot } from "../src/ledger.js";
import type { ProcCpu, ProcRow, ProcTable, SampleRecord } from "../src/types.js";

const NOW = 1_700_000_000_000;
const noDocker = async (): Promise<RawDockerSnapshot> => ({ ok: true, containers: [] });

class FakeTable implements ProcTable {
	rowsCalls = 0;

	constructor(
		private rowsIn: ProcRow[],
		private usage: Map<number, ProcCpu>,
	) {}

	rows(): ProcRow[] | null {
		this.rowsCalls += 1;
		return this.rowsIn;
	}

	rusage(pid: number): ProcCpu | null {
		return this.usage.get(pid) ?? null;
	}

	readEnvTags(): Map<number, string | null> {
		return new Map();
	}

	childPids(pid: number): number[] {
		return this.rowsIn.filter((r) => r.ppid === pid).map((r) => r.pid);
	}

	row(pid: number): ProcRow | null {
		return this.rowsIn.find((r) => r.pid === pid) ?? null;
	}
}

function row(pid: number, ppid: number): ProcRow {
	return { pid, ppid, uid: 501, comm: `p${pid}`, startSec: 1_700_000_000, startUsec: pid };
}

function tempPaths() {
	const root = mkdtempSync(join(tmpdir(), "cpu-sample-client-"));
	return { root, paths: cachePaths(root) };
}

interface ClientHandle {
	client: SharedClient;
	records: SampleRecord[];
}

function makeClient(
	paths: ReturnType<typeof cachePaths>,
	table: ProcTable,
	session: string,
	agentPid: number,
	opts: { inTurn?: () => boolean; enabled?: () => boolean; now?: () => number } = {},
): ClientHandle {
	const records: SampleRecord[] = [];
	const client = new SharedClient({
		paths,
		identity: { session, agent: session.startsWith("pi:") ? "pi" : "claude", agentPid, clientPid: agentPid, cwd: "/w" },
		table,
		docker: noDocker,
		deliver: (record) => records.push(record),
		inTurn: opts.inTurn ?? (() => true),
		enabled: opts.enabled ?? (() => true),
		now: opts.now ?? (() => NOW),
		// The fixture pids stand for live clients, not processes on this machine.
		isAlive: () => true,
	});
	return { client, records };
}

describe("SharedClient", () => {
	it("takes the lock when no owner runs and records its own session", async () => {
		const { root, paths } = tempPaths();
		try {
			const table = new FakeTable([row(100, 0)], new Map([[100, { own: 5, reaped: 0 }]]));
			const { client, records } = makeClient(paths, table, "pi:s1", 100);
			await client.tick();
			assert.equal(records.length, 1);
			assert.equal(records[0]?.session, "pi:s1");
			assert.equal(records[0]?.agentCpuS, 5);
			assert.equal(readLock(paths)?.pid, 100);
			assert.equal(readEntry(paths, "pi-s1")?.busy, true);
			assert.equal(readResult(paths, "pi-s1")?.record.session, "pi:s1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("stays a contender while another owner runs, and delivers what it wrote", async () => {
		const { root, paths } = tempPaths();
		try {
			const table = new FakeTable([row(100, 0), row(200, 0)], new Map([
				[100, { own: 5, reaped: 0 }],
				[200, { own: 3, reaped: 0 }],
			]));
			const owner = makeClient(paths, table, "pi:s1", 100);
			const other = makeClient(paths, table, "claude:s2", 200);
			// The first client takes the lock, then the second registers.
			await owner.client.tick();
			await other.client.tick();
			assert.equal(other.records.length, 0);

			// A contender's tick only refreshes its registration: no table read,
			// no record until an owner samples it.
			const readsWhileContender = table.rowsCalls;
			await other.client.tick();
			assert.equal(table.rowsCalls, readsWhileContender);
			assert.equal(other.records.length, 0);

			// The owner samples both sessions, and the contender delivers its own.
			await owner.client.tick();
			assert.equal(owner.records.length, 2);
			const readsAfterOwner = table.rowsCalls;
			await other.client.tick();
			assert.equal(table.rowsCalls, readsAfterOwner);
			assert.equal(other.records.length, 1);
			assert.equal(other.records[0]?.session, "claude:s2");
			assert.equal(other.records[0]?.agentCpuS, 3);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("delivers a result only once", async () => {
		const { root, paths } = tempPaths();
		try {
			const table = new FakeTable([row(100, 0), row(200, 0)], new Map());
			const owner = makeClient(paths, table, "pi:s1", 100);
			const other = makeClient(paths, table, "claude:s2", 200);
			await owner.client.tick();
			await other.client.tick();
			await owner.client.tick();
			await other.client.tick();
			await other.client.tick();
			await other.client.tick();
			assert.equal(other.records.length, 1);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("takes over when the owner releases the lock", async () => {
		const { root, paths } = tempPaths();
		try {
			const table = new FakeTable([row(100, 0), row(200, 0)], new Map());
			const first = makeClient(paths, table, "pi:s1", 100);
			const second = makeClient(paths, table, "claude:s2", 200);
			await first.client.tick();
			await second.client.tick();
			const reads = table.rowsCalls;
			await first.client.stop();
			await second.client.tick();
			assert.ok(table.rowsCalls > reads);
			assert.equal(readLock(paths)?.key, "claude-s2");
			assert.equal(second.records.at(-1)?.session, "claude:s2");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("stands down and removes its registration when the kill switch turns on", async () => {
		const { root, paths } = tempPaths();
		try {
			const table = new FakeTable([row(100, 0)], new Map());
			let enabled = true;
			const { client, records } = makeClient(paths, table, "pi:s1", 100, { enabled: () => enabled });
			await client.tick();
			assert.equal(readLock(paths)?.key, "pi-s1");
			enabled = false;
			await client.tick();
			assert.equal(readLock(paths), null);
			assert.equal(readEntry(paths, "pi-s1"), null);
			assert.equal(records.length, 1);
			// Turning sampling back on re-registers and takes the lock again.
			enabled = true;
			await client.tick();
			assert.equal(readLock(paths)?.key, "pi-s1");
			assert.equal(records.length, 2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes a final sample as owner, then releases everything", async () => {
		const { root, paths } = tempPaths();
		try {
			const table = new FakeTable([row(100, 0)], new Map([[100, { own: 5, reaped: 0 }]]));
			const { client, records } = makeClient(paths, table, "pi:s1", 100);
			await client.tick();
			await client.stop();
			assert.equal(records.length, 2);
			assert.equal(records.at(-1)?.seq, 1);
			assert.equal(client.isStopped, true);
			assert.equal(readLock(paths), null);
			assert.equal(readEntry(paths, "pi-s1"), null);
			assert.equal(readResult(paths, "pi-s1"), null);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("writes a final sample as a contender and leaves the lock alone", async () => {
		const { root, paths } = tempPaths();
		try {
			const table = new FakeTable([row(100, 0), row(200, 0)], new Map());
			const owner = makeClient(paths, table, "pi:s1", 100);
			const other = makeClient(paths, table, "claude:s2", 200);
			await owner.client.tick();
			await other.client.tick();
			await owner.client.tick();
			await other.client.tick();
			await other.client.stop();
			assert.equal(other.records.at(-1)?.session, "claude:s2");
			assert.equal(readEntry(paths, "claude-s2"), null);
			assert.equal(readResult(paths, "claude-s2"), null);
			assert.equal(readLock(paths)?.key, "pi-s1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("falls back to the standalone driver when the cache directory cannot be used", () => {
		const root = mkdtempSync(join(tmpdir(), "cpu-sample-client-"));
		try {
			const blocker = join(root, "not-a-directory");
			writeFileSync(blocker, "this file keeps the cache directory from being created");
			const paths = cachePaths(join(blocker, "cache"));
			const standalone: SessionDriver = {
				tick: async () => {},
				wake: () => {},
				stop: async () => {},
				isStopped: false,
			};
			const driver = createSessionDriver({
				paths,
				identity: { session: "pi:s1", agent: "pi", agentPid: 100, clientPid: 100, cwd: "/w" },
				table: new FakeTable([], new Map()),
				docker: noDocker,
				deliver: () => {},
				inTurn: () => false,
				log: () => {},
				standalone: () => standalone,
			});
			assert.equal(driver, standalone);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
