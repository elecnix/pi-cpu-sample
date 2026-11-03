import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Sampler, byDepth } from "../src/sample.js";
import type { ContainerObs, RawDockerSnapshot } from "../src/ledger.js";
import type { ProcCpu, ProcRow, ProcTable } from "../src/types.js";

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

	childPids(pid: number): number[] {
		return this.rowsIn.filter((r) => r.ppid === pid).map((r) => r.pid);
	}

	row(pid: number): ProcRow | null {
		return this.rowsIn.find((r) => r.pid === pid) ?? null;
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

	it("reads an untagged process's environment once, then caches the null", async () => {
		let reads = 0;
		const table = new FakeTable(
			[row(100, 0, { comm: "pi" }), row(103, 1, { comm: "daemon" })],
			new Map([
				[100, { own: 0, reaped: 0 }],
				[103, { own: 4, reaped: 0 }],
			]),
		);
		table.readEnvTags = (pids: number[]) => {
			reads++;
			const out = new Map<number, string | null>();
			for (const pid of pids) out.set(pid, null); // the process carries no tag
			return out;
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
		assert.equal(reads, 1);
		await sampler.tick();
		assert.equal(reads, 1); // the null result was cached: no second read
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
		// The sampler inherits the session tag, so without the exclusion it would
		// count as a tagged orphan.
		const table = new FakeTable(
			[row(100, 0, { comm: "pi" }), row(200, 1, { comm: "sampler" })],
			new Map([
				[100, { own: 0, reaped: 0 }],
				[200, { own: 9, reaped: 0 }],
			]),
			new Map([[200, "pi:s1"]]),
		);
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

describe("Sampler.tick with an in-process sampler", () => {
	it("still credits the agent's own CPU when selfPid is the agent pid", async () => {
		// A single-process sampler passes its own pid as selfPid, which is also
		// the agent pid. The agent is the session's main number, so it must
		// stay in the ledger.
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
			selfPid: 100,
			selfUid: 501,
		});
		const rec = await sampler.tick();
		assert.equal(rec.agentCpuS, 5);
		assert.equal(rec.descendantCpuS, 3);
	});

	it("still excludes a separate sampler process from the session", async () => {
		const table = new FakeTable(
			[row(100, 0, { comm: "pi" }), row(200, 1, { comm: "sampler" })],
			new Map([
				[100, { own: 4, reaped: 0 }],
				[200, { own: 9, reaped: 0 }],
			]),
			new Map([[200, "claude:s1"]]),
		);
		const sampler = new Sampler({
			table,
			docker: async () => dockerEmpty,
			agentPid: 100,
			agent: "claude",
			session: "claude:s1",
			cwd: "/w",
			runId: "r1",
			selfPid: 200,
			selfUid: 501,
		});
		const rec = await sampler.tick();
		assert.equal(rec.agentCpuS, 4);
		assert.equal(rec.descendantCpuS, 0);
		// The tagged sampler would land in the orphan bucket without the skip.
		assert.equal(rec.taggedOrphanCpuS, 0);
	});
});

describe("read order", () => {
	it("reads a parent's CPU before its children's", () => {
		// The rusage reads are separate calls. Reading a parent first means a child
		// that exits mid-pass is either absent from its own read or already inside
		// the parent's reaped total, never both.
		const rows = [row(102, 101), row(101, 100), row(100, 0), row(200, 0)];
		const ordered = byDepth(rows).map((r) => r.pid);
		assert.ok(ordered.indexOf(100) < ordered.indexOf(101));
		assert.ok(ordered.indexOf(101) < ordered.indexOf(102));
		assert.deepEqual([...ordered].sort((a, b) => a - b), [100, 101, 102, 200]);
	});
});

describe("the Docker VM total", () => {
	const options = (table: FakeTable) => ({
		table,
		docker: async () => dockerEmpty,
		agentPid: 100,
		agent: "pi" as const,
		session: "pi:s1",
		cwd: "/w",
		runId: "r1",
		selfPid: 999,
		selfUid: 501,
	});

	it("never goes down when a helper exits", async () => {
		const first = new FakeTable(
			[
				row(100, 0, { comm: "pi" }),
				row(104, 1, { comm: "com.docker.backend", startSec: 1_700_000_000 }),
				row(105, 1, { comm: "com.docker.sailor", startSec: 1_700_000_000 }),
			],
			new Map([
				[100, { own: 0, reaped: 0 }],
				[104, { own: 30, reaped: 0 }],
				[105, { own: 10, reaped: 0 }],
			]),
		);
		const sampler = new Sampler(options(first));
		assert.equal((await sampler.tick()).dockerVmCpuS, 40);
		// The backend exits; the sailor keeps running and its own counter grew.
		const second = new FakeTable(
			[row(100, 0, { comm: "pi" }), row(105, 1, { comm: "com.docker.sailor", startSec: 1_700_000_000 })],
			new Map([
				[100, { own: 0, reaped: 0 }],
				[105, { own: 12, reaped: 0 }],
			]),
		);
		sampler.replaceTable(second);
		const rec = await sampler.tick();
		assert.equal(rec.dockerVmBoot, String(1_700_000_000), "the VM did not restart");
		assert.equal(rec.dockerVmCpuS, 42, "the departed helper's 30 s stays in the total");
	});

	it("starts over when the VM restarts", async () => {
		const first = new FakeTable(
			[row(100, 0, { comm: "pi" }), row(104, 1, { comm: "com.docker.backend", startSec: 1_700_000_000 })],
			new Map([
				[100, { own: 0, reaped: 0 }],
				[104, { own: 30, reaped: 0 }],
			]),
		);
		const sampler = new Sampler(options(first));
		assert.equal((await sampler.tick()).dockerVmCpuS, 30);
		// A new VM process: its counter starts from zero, and the reader books the
		// new value rather than a negative delta.
		const restarted = new FakeTable(
			[row(100, 0, { comm: "pi" }), row(106, 1, { comm: "com.docker.backend", startSec: 1_700_000_500 })],
			new Map([
				[100, { own: 0, reaped: 0 }],
				[106, { own: 5, reaped: 0 }],
			]),
		);
		sampler.replaceTable(restarted);
		const rec = await sampler.tick();
		assert.equal(rec.dockerVmBoot, String(1_700_000_500));
		assert.equal(rec.dockerVmCpuS, 5);
	});
});
