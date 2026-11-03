import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classify, SessionLedger, DockerLedger } from "../src/ledger.js";
import type { ProcRow, ProcCpu } from "../src/types.js";

function row(pid: number, ppid: number, opts: Partial<ProcRow> = {}): ProcRow {
	return {
		pid,
		ppid,
		uid: 501,
		comm: `p${pid}`,
		startSec: 1_700_000_000 + pid,
		startUsec: 0,
		...opts,
	};
}

function cpu(own: number, reaped: number): ProcCpu {
	return { own, reaped };
}

describe("classify", () => {
	const rows = [
		row(100, 0, { comm: "pi" }), // the agent itself, parent outside the table
		row(101, 100, { comm: "bash" }),
		row(102, 101, { comm: "node" }),
		row(103, 1, { comm: "orphan" }), // reparented to launchd, untagged
		row(104, 1, { comm: "com.docker.backend" }),
		row(105, 999, { comm: "stray", uid: 0 }), // another user's process
	];

	it("walks the parent chain from the agent pid", () => {
		const m = classify(rows, 100, new Set());
		assert.deepEqual([...m.tree].sort(), ["100:1700000100:0", "101:1700000101:0", "102:1700000102:0"]);
	});

	it("does not count a second agent root", () => {
		const m = classify(rows, 101, new Set());
		assert.deepEqual([...m.tree].sort(), ["101:1700000101:0", "102:1700000102:0"]);
	});

	it("separates docker host processes by name prefix", () => {
		const m = classify(rows, 100, new Set());
		assert.deepEqual([...m.dockerHost], ["104:1700000104:0"]);
	});

	it("ignores a process whose parent is outside the table unless it is tagged", () => {
		const m = classify(rows, 100, new Set(["103:1700000103:0"]));
		assert.ok(!m.tree.has("103:1700000103:0"));
		assert.ok(!m.dockerHost.has("103:1700000103:0"));
	});

	it("never treats the docker host processes as session members", () => {
		const m = classify(rows, 100, new Set(["104:1700000104:0"]));
		assert.ok(!m.tree.has("104:1700000104:0"));
	});
});

describe("SessionLedger", () => {
	it("sums own and reaped time of the session set", () => {
		const ledger = new SessionLedger(100, new Set());
		const rows = [row(100, 0), row(101, 100), row(102, 101)];
		const usage = new Map<number, ProcCpu>([
			[100, cpu(10, 1)],
			[101, cpu(2, 0.5)],
			[102, cpu(3, 0)],
		]);
		const buckets = ledger.consume(rows, new Set(), usage);
		assert.equal(buckets.agentCpuS, 10);
		// descendant = agent's reaped (1) + 101 (2.5) + 102 (3)
		assert.equal(buckets.descendantCpuS, 6.5);
		assert.equal(buckets.taggedOrphanCpuS, 0);
	});

	it("books tagged orphans outside the tree separately", () => {
		const ledger = new SessionLedger(100, new Set());
		const rows = [row(100, 0), row(103, 1)];
		const usage = new Map<number, ProcCpu>([
			[100, cpu(10, 0)],
			[103, cpu(4, 0)],
		]);
		const buckets = ledger.consume(rows, new Set(["103:1700000103:0"]), usage);
		assert.equal(buckets.agentCpuS, 10);
		assert.equal(buckets.descendantCpuS, 0);
		assert.equal(buckets.taggedOrphanCpuS, 4);
	});

	it("does not add a vanished child's time twice when its parent reaped it", () => {
		// The table still lists the child, but the rusage read fails because its
		// parent reaped it between the two calls. The parent's reaped total now
		// includes the child's time, so the child must add nothing of its own.
		const ledger = new SessionLedger(100, new Set());
		ledger.consume([row(100, 0), row(101, 100)], new Set(), new Map([
			[100, cpu(10, 0)],
			[101, cpu(2, 0)],
		]));
		const after = ledger.consume([row(100, 0), row(101, 100)], new Set(), new Map([
			[100, cpu(10, 2)],
		]));
		assert.equal(after.descendantCpuS, 2);
	});

	it("keeps the total when a rusage read fails", () => {
		const ledger = new SessionLedger(100, new Set());
		const rows = [row(100, 0), row(101, 100)];
		const first = new Map<number, ProcCpu>([
			[100, cpu(10, 0)],
			[101, cpu(2, 0)],
		]);
		ledger.consume(rows, new Set(), first);
		// The read for 101 fails this tick: it is simply absent from the map.
		const second = new Map<number, ProcCpu>([[100, cpu(11, 0)]]);
		const buckets = ledger.consume(rows, new Set(), second);
		// 101's last known total (2) still counts, so the ledger cannot dip
		assert.equal(buckets.descendantCpuS, 2);
	});

	it("stops carrying a key once its process leaves the table", () => {
		const ledger = new SessionLedger(100, new Set());
		const withChild = [row(100, 0), row(101, 100)];
		const usage = new Map<number, ProcCpu>([
			[100, cpu(10, 5)],
			[101, cpu(2, 0)],
		]);
		ledger.consume(withChild, new Set(), usage);
		// The child exited and was reaped: its time moved into the parent's reaped total.
		const after = [row(100, 0)];
		const usage2 = new Map<number, ProcCpu>([[100, cpu(11, 7)]]);
		const buckets = ledger.consume(after, new Set(), usage2);
		assert.equal(buckets.agentCpuS, 11);
		assert.equal(buckets.descendantCpuS, 7);
	});

	it("counts a tagged process that started in the tree only once", () => {
		// A member can carry the tag and still have started inside the tree. If
		// it moved to the orphan bucket when it was reparented, its earlier
		// contribution would stay in the descendant floor and its whole total
		// would be added again.
		const ledger = new SessionLedger(100, new Set());
		const key = "101:1700000101:0";
		const tagged = new Set([key]);
		ledger.consume([row(100, 0), row(101, 100)], tagged, new Map([
			[100, cpu(10, 0)],
			[101, cpu(2, 0)],
		]));
		const after = ledger.consume([row(100, 0), row(101, 1)], tagged, new Map([
			[100, cpu(10, 0)],
			[101, cpu(3, 0)],
		]));
		assert.equal(after.descendantCpuS + after.taggedOrphanCpuS, 3);
	});

	it("keeps a reparented session member after it leaves the tree", () => {
		const ledger = new SessionLedger(100, new Set());
		// 101 starts inside the tree, then its parent exits and it is reparented.
		ledger.consume([row(100, 0), row(101, 100)], new Set(), new Map([
			[100, cpu(0, 0)],
			[101, cpu(1, 0)],
		]));
		const buckets = ledger.consume([row(100, 0), row(101, 1)], new Set(), new Map([
			[100, cpu(0, 0)],
			[101, cpu(3, 0)],
		]));
		assert.equal(buckets.descendantCpuS, 3);
	});

	it("lists live processes largest first, capped", () => {
		const ledger = new SessionLedger(100, new Set());
		const rows = [row(100, 0)];
		for (let i = 1; i <= 70; i++) rows.push(row(i, 100));
		const usage = new Map<number, ProcCpu>([[100, cpu(10, 0)]]);
		for (let i = 1; i <= 70; i++) usage.set(i, cpu(i, 0));
		const buckets = ledger.consume(rows, new Set(), usage);
		assert.equal(buckets.procs.length, 64);
		assert.equal(buckets.procsTruncated, true);
		assert.equal(buckets.procs[0]?.cpuS, 70);
		assert.equal(buckets.procs[0]?.pid, 70);
	});
});

describe("DockerLedger", () => {
	it("sums current container counters per stack", () => {
		const ledger = new DockerLedger();
		const sample = ledger.consume([
			{ id: "a", project: "web", dir: "/w/deploy/local", cpuS: 10 },
			{ id: "b", project: "web", dir: "/w/deploy/local", cpuS: 5 },
		]);
		assert.equal(sample.ok, true);
		assert.equal(sample.stacks.length, 1);
		assert.equal(sample.stacks[0]?.cpuS, 15);
		assert.equal(sample.stacks[0]?.containers["a"], 10);
	});

	it("keeps a removed container's last value in the stack total", () => {
		const ledger = new DockerLedger();
		ledger.consume([{ id: "a", project: "web", dir: "/w", cpuS: 10 }]);
		const sample = ledger.consume([{ id: "b", project: "web", dir: "/w", cpuS: 7 }]);
		assert.equal(sample.stacks[0]?.cpuS, 17);
		// The removed container no longer reports a counter.
		assert.equal(sample.stacks[0]?.containers["a"], undefined);
		assert.equal(sample.stacks[0]?.containers["b"], 7);
	});

	it("treats a dropped counter as a container restart and reports the new value", () => {
		const ledger = new DockerLedger();
		ledger.consume([{ id: "a", project: "web", dir: "/w", cpuS: 100 }]);
		const sample = ledger.consume([{ id: "a", project: "web", dir: "/w", cpuS: 3 }]);
		assert.equal(sample.stacks[0]?.cpuS, 3);
		assert.equal(sample.stacks[0]?.containers["a"], 3);
	});

	it("groups stacks by directory and project", () => {
		const ledger = new DockerLedger();
		const sample = ledger.consume([
			{ id: "a", project: "web", dir: "/w1", cpuS: 10 },
			{ id: "b", project: "db", dir: "/w2", cpuS: 20 },
		]);
		assert.equal(sample.stacks.length, 2);
	});
});

describe("SessionLedger with members outside the tree", () => {
	it("keeps an exited tagged orphan's CPU in the total", () => {
		const ledger = new SessionLedger(100, new Set());
		const agent = row(100, 0);
		// A tagged daemon that is not a descendant: launchd owns it, so no
		// session parent folds its time into a reaped total when it exits.
		const orphan = row(300, 1);
		const key = "300:1700000300:0";
		ledger.consume([agent, orphan], new Set([key]), new Map([
			[100, cpu(10, 0)],
			[300, cpu(4, 0)],
		]));
		const after = ledger.consume([agent], new Set([key]), new Map([[100, cpu(10, 0)]]));
		assert.equal(after.taggedOrphanCpuS, 4);
	});

	it("does not double count a tagged child reaped by a tagged parent", () => {
		// Both processes live outside the agent's tree. The child exits first,
		// then its parent reaps it, which raises the parent's reaped total. The
		// child's time must not also be carried on its own key.
		const ledger = new SessionLedger(100, new Set());
		const parentKey = "300:1700000300:0";
		const childKey = "301:1700000301:0";
		const keys = new Set([parentKey, childKey]);
		ledger.consume([row(100, 0), row(300, 1), row(301, 300)], keys, new Map([
			[100, cpu(10, 0)],
			[300, cpu(2, 0)],
			[301, cpu(5, 0)],
		]));
		const after = ledger.consume([row(100, 0), row(300, 1)], keys, new Map([
			[100, cpu(10, 0)],
			[300, cpu(2, 5)],
		]));
		assert.equal(after.taggedOrphanCpuS, 7);
	});

	it("does not carry a tagged process that a session parent reaped", () => {
		const ledger = new SessionLedger(100, new Set());
		// 101 is tagged but starts inside the tree, so a session process owns
		// its exit and folds the time into a reaped total.
		const key = "101:1700000101:0";
		ledger.consume([row(100, 0), row(101, 100)], new Set([key]), new Map([
			[100, cpu(10, 0)],
			[101, cpu(3, 0)],
		]));
		ledger.consume([row(100, 0), row(101, 100)], new Set([key]), new Map([
			[100, cpu(10, 0)],
			[101, cpu(4, 0)],
		]));
		// The parent reaped it; its 4 CPU-s now appear in the parent's reaped time.
		const after = ledger.consume([row(100, 0)], new Set([key]), new Map([[100, cpu(10, 4)]]));
		assert.equal(after.descendantCpuS, 4);
	});

	it("adds a departed member's total as the live members grow", () => {
		// A floor alone loses this: once the live sum passes the held value the
		// departed member's time would be replaced, not added.
		const ledger = new SessionLedger(100, new Set());
		ledger.consume([row(100, 0), row(300, 1)], new Set(["300:1700000300:0"]), new Map([
			[100, cpu(10, 0)],
			[300, cpu(5, 0)],
		]));
		// The sampler keeps its tag cache across ticks, so the departed key is
		// still in the tagged set.
		const after = ledger.consume([row(100, 0), row(400, 1)], new Set(["300:1700000300:0", "400:1700000400:0"]), new Map([
			[100, cpu(10, 0)],
			[400, cpu(10, 0)],
		]));
		assert.equal(after.taggedOrphanCpuS, 15);
	});

	it("holds a reparented member's last total after it exits", () => {
		const ledger = new SessionLedger(100, new Set());
		const child = row(101, 100);
		ledger.consume([row(100, 0), child], new Set(), new Map([
			[100, cpu(10, 0)],
			[101, cpu(3, 0)],
		]));
		// The child reparented to launchd, so the agent never reports its exit.
		ledger.consume([row(100, 0), row(101, 1)], new Set(), new Map([
			[100, cpu(10, 0)],
			[101, cpu(5, 0)],
		]));
		const after = ledger.consume([row(100, 0)], new Set(), new Map([[100, cpu(10, 0)]]));
		assert.equal(after.descendantCpuS, 5);
	});
});
