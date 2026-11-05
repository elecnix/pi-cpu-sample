import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
	MachinePass,
	exportAccountState,
	sessionAccount,
	sessionRecord,
	type SessionAccount,
} from "../src/shared.js";
import type { ContainerObs, RawDockerSnapshot } from "../src/ledger.js";
import type { ProcCpu, ProcRow, ProcTable } from "../src/types.js";
import type { SessionState } from "../src/registry.js";

/** A process table built from a literal list; counts the reads it serves. */
class FakeTable implements ProcTable {
	constructor(
		private rowsIn: ProcRow[],
		private usage: Map<number, ProcCpu>,
		private tags = new Map<number, string | null>(),
	) {}

	rows(): ProcRow[] | null {
		this.rowsCalls += 1;
		return this.rowsIn;
	}

	rowsCalls = 0;

	setRows(rows: ProcRow[]): void {
		this.rowsIn = rows;
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

	envScans = 0;

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
	return {
		pid,
		ppid,
		uid: 501,
		comm: `p${pid}`,
		startSec: 1_700_000_000,
		startUsec: pid,
		...opts,
	};
}

const noDocker = async (): Promise<RawDockerSnapshot> => ({ ok: true, containers: [] });

function account(session: string, agentPid: number): SessionAccount {
	if (session.startsWith("pi:")) {
		return sessionAccount({ session, agent: "pi", agentPid, cwd: "/w", excludePid: -1 });
	}
	return sessionAccount({ session, agent: "claude", agentPid, cwd: "/w", excludePid: -1 });
}

describe("MachinePass", () => {
	it("reads the table and Docker once for every session in the pass", async () => {
		const table = new FakeTable(
			[row(100, 0, { comm: "pi" }), row(101, 100), row(200, 0, { comm: "claude" }), row(201, 200)],
			new Map([
				[100, { own: 5, reaped: 0 }],
				[101, { own: 2, reaped: 0 }],
				[200, { own: 3, reaped: 0 }],
				[201, { own: 1, reaped: 0 }],
			]),
		);
		let dockerCalls = 0;
		const machine = new MachinePass({
			table,
			docker: async () => {
				dockerCalls += 1;
				return { ok: true, containers: [] };
			},
			selfUid: 501,
		});
		const obs = await machine.observe(new Set());
		const a = account("pi:a", 100);
		const b = account("claude:b", 200);
		const ra = sessionRecord(a, obs, { cpuS: 0.01, wallS: 0.02 }, 1_700_000_030_000);
		const rb = sessionRecord(b, obs, { cpuS: 0.01, wallS: 0.02 }, 1_700_000_030_000);
		assert.equal(table.rowsCalls, 1);
		assert.equal(dockerCalls, 1);
		assert.equal(ra.agentCpuS, 5);
		assert.equal(ra.descendantCpuS, 2);
		assert.equal(rb.agentCpuS, 3);
		assert.equal(rb.descendantCpuS, 1);
	});

	it("gives every session its own tagged orphans", async () => {
		const table = new FakeTable(
			[row(100, 0), row(200, 0), row(300, 1), row(301, 1)],
			new Map([
				[100, { own: 1, reaped: 0 }],
				[200, { own: 1, reaped: 0 }],
				[300, { own: 4, reaped: 0 }],
				[301, { own: 7, reaped: 0 }],
			]),
			new Map([
				[300, "pi:a"],
				[301, "claude:b"],
			]),
		);
		const machine = new MachinePass({ table, docker: noDocker, selfUid: 501 });
		const obs = await machine.observe(new Set());
		const ra = sessionRecord(account("pi:a", 100), obs, { cpuS: 0, wallS: 0 }, 1_700_000_000_000);
		const rb = sessionRecord(account("claude:b", 200), obs, { cpuS: 0, wallS: 0 }, 1_700_000_000_000);
		assert.equal(ra.taggedOrphanCpuS, 4);
		assert.equal(rb.taggedOrphanCpuS, 7);
	});

	it("scans the environment of a new process once for the whole machine", async () => {
		const table = new FakeTable(
			[row(100, 0), row(200, 0), row(300, 1)],
			new Map([
				[100, { own: 1, reaped: 0 }],
				[200, { own: 1, reaped: 0 }],
				[300, { own: 1, reaped: 0 }],
			]),
			new Map([[300, "pi:a"]]),
		);
		const machine = new MachinePass({ table, docker: noDocker, selfUid: 501 });
		const a = account("pi:a", 100);
		const b = account("claude:b", 200);
		for (let i = 0; i < 3; i++) {
			const obs = await machine.observe(new Set());
			sessionRecord(a, obs, { cpuS: 0, wallS: 0 }, 1_700_000_000_000 + i * 30_000);
			sessionRecord(b, obs, { cpuS: 0, wallS: 0 }, 1_700_000_000_000 + i * 30_000);
		}
		assert.equal(table.rowsCalls, 3);
		assert.equal(table.envScans, 1);
	});

	it("reads Docker once and hands each session the stacks under its cwd", async () => {
		const table = new FakeTable([row(100, 0), row(200, 0)], new Map());
		const containers: ContainerObs[] = [
			{ id: "c1", project: "a", dir: "/w/a", cpuS: 2 },
			{ id: "c2", project: "b", dir: "/w/a/nested", cpuS: 3 },
			{ id: "c3", project: "c", dir: "/elsewhere", cpuS: 5 },
		];
		const machine = new MachinePass({
			table,
			docker: async () => ({ ok: true, containers }),
			selfUid: 501,
		});
		const obs = await machine.observe(new Set());
		const a = sessionAccount({ session: "pi:a", agent: "pi", agentPid: 100, cwd: "/w/a", excludePid: -1 });
		const b = sessionAccount({ session: "claude:b", agent: "claude", agentPid: 200, cwd: "/w/b", excludePid: -1 });
		const ra = sessionRecord(a, obs, { cpuS: 0, wallS: 0 }, 1_700_000_000_000);
		const rb = sessionRecord(b, obs, { cpuS: 0, wallS: 0 }, 1_700_000_000_000);
		assert.deepEqual(
			ra.docker.stacks.map((s) => s.project),
			["a", "b"],
		);
		assert.deepEqual(rb.docker.stacks, []);
	});

	it("counts the Docker VM total once and keeps it across a helper exit", async () => {
		const table = new FakeTable(
			[row(400, 0, { comm: "com.docker.virtualization" }), row(401, 0, { comm: "Docker Helper" })],
			new Map([
				[400, { own: 10, reaped: 0 }],
				[401, { own: 2, reaped: 0 }],
			]),
		);
		const machine = new MachinePass({ table, docker: noDocker, selfUid: 501 });
		const a = account("pi:a", 100);
		const first = sessionRecord(a, await machine.observe(new Set()), { cpuS: 0, wallS: 0 }, 1_700_000_000_000);
		assert.equal(first.dockerVmCpuS, 12);
		assert.equal(first.dockerVmBoot, "1700000000");
		// The helper exits and its total stays with the VM.
		table.setRows([row(400, 0, { comm: "com.docker.virtualization" })]);
		const second = sessionRecord(a, await machine.observe(new Set()), { cpuS: 0, wallS: 0 }, 1_700_000_030_000);
		assert.equal(second.dockerVmCpuS, 12);
	});

	it("excludes the session's own instrumentation process", async () => {
		const table = new FakeTable(
			[row(200, 0, { comm: "claude" }), row(201, 200, { comm: "python3" })],
			new Map([
				[200, { own: 2, reaped: 0 }],
				[201, { own: 9, reaped: 0 }],
			]),
		);
		const machine = new MachinePass({ table, docker: noDocker, selfUid: 501 });
		const obs = await machine.observe(new Set([201]));
		const withSampler = sessionAccount({ session: "claude:b", agent: "claude", agentPid: 200, cwd: "/w", excludePid: 201 });
		const rec = sessionRecord(withSampler, obs, { cpuS: 0, wallS: 0 }, 1_700_000_000_000);
		assert.equal(rec.descendantCpuS, 0);
		assert.deepEqual(
			rec.procs.map((p) => [p.pid, p.cpuS]),
			[[200, 2], [201, 0]],
		);
	});
});

describe("session state", () => {
	it("continues the same run and totals after a handover", async () => {
		const table = new FakeTable(
			[row(100, 0, { comm: "pi" }), row(101, 100)],
			new Map([
				[100, { own: 5, reaped: 0 }],
				[101, { own: 2, reaped: 0 }],
			]),
		);
		const first = new MachinePass({ table, docker: noDocker, selfUid: 501 });
		const a = sessionAccount({ session: "pi:a", agent: "pi", agentPid: 100, cwd: "/w", excludePid: -1 });
		const before = sessionRecord(a, await first.observe(new Set()), { cpuS: 0, wallS: 0 }, 1_700_000_000_000);
		assert.equal(before.seq, 0);
		assert.equal(before.agentCpuS, 5);

		// The owner dies. A new owner process restores the exported state and
		// reads the machine again: the counters only grow, and the run continues.
		const state: SessionState = exportAccountState(a);
		const second = new MachinePass({ table, docker: noDocker, selfUid: 501 });
		const b = sessionAccount({
			session: "pi:a",
			agent: "pi",
			agentPid: 100,
			cwd: "/w",
			excludePid: -1,
			state,
		});
		table.setUsage(100, { own: 6, reaped: 0 });
		table.setUsage(101, { own: 4, reaped: 0 });
		const after = sessionRecord(b, await second.observe(new Set()), { cpuS: 0, wallS: 0 }, 1_700_000_030_000);
		assert.equal(after.run, before.run);
		assert.equal(after.seq, 1);
		assert.equal(after.intervalS, 30);
		assert.equal(after.agentCpuS, 6);
		assert.equal(after.descendantCpuS, 4);
	});

	it("keeps the time of a member that left before the handover", async () => {
		const table = new FakeTable(
			[row(100, 0), row(300, 1, { startSec: 1_700_000_001, startUsec: 1 })],
			new Map([
				[100, { own: 5, reaped: 0 }],
				[300, { own: 8, reaped: 0 }],
			]),
			new Map([[300, "pi:a"]]),
		);
		const first = new MachinePass({ table, docker: noDocker, selfUid: 501 });
		const a = sessionAccount({ session: "pi:a", agent: "pi", agentPid: 100, cwd: "/w", excludePid: -1 });
		const before = sessionRecord(a, await first.observe(new Set()), { cpuS: 0, wallS: 0 }, 1_700_000_000_000);
		assert.equal(before.taggedOrphanCpuS, 8);

		const state = exportAccountState(a);
		// The orphan exits while no owner runs.
		const second = new MachinePass({
			table: new FakeTable([row(100, 0)], new Map([[100, { own: 6, reaped: 0 }]])),
			docker: noDocker,
			selfUid: 501,
		});
		const b = sessionAccount({ session: "pi:a", agent: "pi", agentPid: 100, cwd: "/w", excludePid: -1, state });
		const after = sessionRecord(b, await second.observe(new Set()), { cpuS: 0, wallS: 0 }, 1_700_000_030_000);
		// The departed member's last total stays counted, and the agent grew.
		assert.equal(after.taggedOrphanCpuS, 8);
		assert.equal(after.agentCpuS, 6);
	});

	it("starts a new run when it has no state", () => {
		const a = sessionAccount({ session: "pi:a", agent: "pi", agentPid: 100, cwd: "/w", excludePid: -1 });
		const b = sessionAccount({ session: "pi:a", agent: "pi", agentPid: 100, cwd: "/w", excludePid: -1 });
		assert.notEqual(a.runId, b.runId);
		assert.equal(a.seq, 0);
		assert.equal(a.lastTs, null);
	});
});

describe("cross-language state", () => {
	it("restores a result file as the Python sampler writes it", () => {
		// The wire format shared with skills/cpu-sample/scripts/shared.py. The
		// literal here mirrors what that module writes, field for field.
		const pythonState: SessionState = {
			run: "run-from-python",
			seq: 7,
			lastTs: 1_700_000_000_000,
			ledger: {
				lastBuckets: { agent: 8, descendant: 3, taggedOrphan: 0 },
				bucketOf: [["100:1700000000:100", "agent"]],
				lastTotal: [["100:1700000000:100", 11]],
				lastParent: [["100:1700000000:100", null]],
			},
			everInTree: ["100:1700000000:100"],
			outsideTree: [],
			dockerSeen: [{ id: "c1", project: "p", dir: "/w", cpuS: 2 }],
		};
		const account = sessionAccount({
			session: "claude:abc",
			agent: "claude",
			agentPid: 100,
			cwd: "/w",
			excludePid: -1,
			state: pythonState,
		});
		assert.equal(account.runId, "run-from-python");
		assert.equal(account.seq, 7);
		assert.ok(account.everInTree.has("100:1700000000:100"));
		assert.equal(account.dockerLedger.exportState()[0]?.project, "p");
	});
});

describe("the machine-wide cache", () => {
	it("drops the entry of a process that left the table", async () => {
		const table = new FakeTable(
			[row(100, 0), row(300, 1)],
			new Map([
				[100, { own: 1, reaped: 0 }],
				[300, { own: 4, reaped: 0 }],
			]),
			new Map([[300, "pi:a"]]),
		);
		const machine = new MachinePass({ table, docker: noDocker, selfUid: 501 });
		const a = sessionAccount({ session: "pi:a", agent: "pi", agentPid: 100, cwd: "/w", excludePid: -1 });
		sessionRecord(a, await machine.observe(new Set()), { cpuS: 0, wallS: 0 }, 1_700_000_000_000);
		assert.equal(machine.exportState(1, 0).tags.length, 2);
		table.setRows([row(100, 0)]);
		sessionRecord(a, await machine.observe(new Set()), { cpuS: 0, wallS: 0 }, 1_700_000_030_000);
		const tags = machine.exportState(1, 0).tags;
		assert.deepEqual(
			tags.map(([key]) => key),
			["100:1700000000:100"],
		);
	});
});
