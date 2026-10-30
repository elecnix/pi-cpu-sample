import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Sampler, type ProcTable, type ProcRow, type ProcCpu, type RawDockerSnapshot } from "../src/sample.js";

/** A process table built from a literal list; rusage comes from a map. */
class FakeTable implements ProcTable {
	constructor(
		private rowsIn: ProcRow[],
		private usage: Map<number, ProcCpu>,
		private tags = new Map<number, string | null>(),
	) {}

	rows(): ProcRow[] | null {
		return this.rowsIn;
	}

	rusage(pid: number): ProcCpu | null {
		return this.usage.get(pid) ?? null;
	}

	readEnvTags(pids: number[]): Map<number, string | null> {
		const out = new Map<number, string | null>();
		for (const pid of pids) out.set(pid, this.tags.get(pid) ?? null);
		return out;
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

const dockerEmpty: RawDockerSnapshot = { ok: true, containers: [] };

describe("Sampler.tick", () => {
	it("produces a first sample that is a pure baseline", async () => {
		const table = new FakeTable([row(100, 0, { comm: "pi" }), row(101, 100)], new Map([
			[100, { own: 5, reaped: 1 }],
			[101, { own: 2, reaped: 0 }],
		]));
		const sampler = new Sampler({
			table,
			docker: async () => dockerEmpty,
			agentPid: 100,
			agent: "pi",
			session: "pi:s1",
			cwd: "/w",
			runId: "r1",
			selfPid: 999,
			selfUid: 501,
		});
		const rec = await sampler.tick();
		assert.equal(rec.v, 1);
		assert.equal(rec.seq, 0);
		assert.equal(rec.intervalS, null);
		assert.equal(rec.agentCpuS, 5);
		// the agent's reaped children are descendants too
		assert.equal(rec.descendantCpuS, 3);
		assert.equal(rec.session, "pi:s1");
		assert.equal(rec.agentPid, 100);
		assert.deepEqual(rec.procs.find((p) => p.pid === 101), { name: "p101", pid: 101, cpuS: 2 });
	});

	it("keeps a process that was in the tree after it is reparented, without an env read", async () => {
		let envReads = 0;
		const table = new FakeTable([row(100, 0, { comm: "pi" }), row(101, 100)], new Map([
			[100, { own: 0, reaped: 0 }],
			[101, { own: 1, reaped: 0 }],
		]));
		table.readEnvTags = () => {
			envReads++;
			return new Map();
		};
		const sampler = new Sampler({
			table,
			docker: async () => dockerEmpty,
			agentPid: 100,
			agent: "pi",
			session: "pi:s1",
			cwd: "/w",
			runId: "r1",
			selfPid: 999,
			selfUid: 501,
		});
		await sampler.tick();
		assert.equal(envReads, 0); // tree members need no env read
		const after = new FakeTable([row(100, 0, { comm: "pi" }), row(101, 1)], new Map([
			[100, { own: 0, reaped: 0 }],
			[101, { own: 3, reaped: 0 }],
		]));
		after.readEnvTags = table.readEnvTags;
		sampler.replaceTable(after);
		const rec = await sampler.tick();
		assert.equal(envReads, 0); // membership inherited from the tree, not the env
		assert.equal(rec.descendantCpuS, 3);
	});

	it("picks up a tagged orphan it has never seen in the tree", async () => {
		const table = new FakeTable(
			[row(100, 0, { comm: "pi" }), row(103, 1, { comm: "daemon" })],
			new Map([
				[100, { own: 0, reaped: 0 }],
				[103, { own: 4, reaped: 0 }],
			]),
			new Map([[103, "pi:s1"]]),
		);
		const sampler = new Sampler({
			table,
			docker: async () => dockerEmpty,
			agentPid: 100,
			agent: "pi",
			session: "pi:s1",
			cwd: "/w",
			runId: "r1",
			selfPid: 999,
			selfUid: 501,
		});
		const rec = await sampler.tick();
		assert.equal(rec.taggedOrphanCpuS, 4);
	});

	it("ignores a process tagged for a different session", async () => {
		const table = new FakeTable(
			[row(100, 0, { comm: "pi" }), row(103, 1, { comm: "daemon" })],
			new Map([
				[100, { own: 0, reaped: 0 }],
				[103, { own: 4, reaped: 0 }],
			]),
			new Map([[103, "pi:other"]]),
		);
		const sampler = new Sampler({
			table,
			docker: async () => dockerEmpty,
			agentPid: 100,
			agent: "pi",
			session: "pi:s1",
			cwd: "/w",
			runId: "r1",
			selfPid: 999,
			selfUid: 501,
		});
		const rec = await sampler.tick();
		assert.equal(rec.taggedOrphanCpuS, 0);
	});

	it("reports docker stacks under the cwd and the VM total", async () => {
		const table = new FakeTable(
			[
				row(100, 0, { comm: "pi" }),
				row(104, 1, { comm: "com.docker.backend", startSec: 1_700_000_000 }),
				row(105, 1, { comm: "com.docker.sailor", startSec: 1_700_000_100 }),
			],
			new Map([
				[100, { own: 0, reaped: 0 }],
				[104, { own: 30, reaped: 2 }],
				[105, { own: 10, reaped: 0 }],
			]),
		);
		const sampler = new Sampler({
			table,
			docker: async () => ({ ok: true, containers: [{ id: "aaa", project: "web", dir: "/w/deploy/local", cpuS: 12.5 }] }),
			agentPid: 100,
			agent: "pi",
			session: "pi:s1",
			cwd: "/w",
			runId: "r1",
			selfPid: 999,
		});
		const rec = await sampler.tick();
		assert.equal(rec.docker.ok, true);
		assert.equal(rec.docker.stacks[0]?.cpuS, 12.5);
		assert.equal(rec.docker.stacks[0]?.containers["aaa"], 12.5);
		assert.equal(rec.dockerVmCpuS, 42);
		assert.equal(rec.dockerVmBoot, String(1_700_000_100));
	});

	it("reports a failed docker engine as not ok, without throwing", async () => {
		const table = new FakeTable([row(100, 0, { comm: "pi" })], new Map([[100, { own: 0, reaped: 0 }]]));
		const sampler = new Sampler({
			table,
			docker: async () => {
				throw new Error("connection refused");
			},
			agentPid: 100,
			agent: "pi",
			session: "pi:s1",
			cwd: "/w",
			runId: "r1",
			selfPid: 100,
			selfUid: 501,
		});
		const rec = await sampler.tick();
		assert.equal(rec.docker.ok, false);
		assert.equal(rec.docker.stacks.length, 0);
	});

	it("seq and intervalS advance across ticks", async () => {
		const table = new FakeTable([row(100, 0, { comm: "pi" })], new Map([[100, { own: 0, reaped: 0 }]]));
		const sampler = new Sampler({
			table,
			docker: async () => dockerEmpty,
			agentPid: 100,
			agent: "pi",
			session: "pi:s1",
			cwd: "/w",
			runId: "r1",
			selfPid: 100,
			selfUid: 501,
		});
		await sampler.tick();
		const rec = await sampler.tick();
		assert.equal(rec.seq, 1);
		assert.ok(rec.intervalS !== null && rec.intervalS < 1);
	});

	it("does not count the sampler process in the session", async () => {
		const table = new FakeTable([row(100, 0, { comm: "pi" }), row(200, 1, { comm: "sampler" })], new Map([
			[100, { own: 0, reaped: 0 }],
			[200, { own: 9, reaped: 0 }],
		]));
		const sampler = new Sampler({
			table,
			docker: async () => dockerEmpty,
			agentPid: 100,
			agent: "pi",
			session: "pi:s1",
			cwd: "/w",
			runId: "r1",
			selfPid: 200,
			selfUid: 501,
		});
		const rec = await sampler.tick();
		assert.equal(rec.agentCpuS + rec.descendantCpuS + rec.taggedOrphanCpuS, 0);
	});
});
