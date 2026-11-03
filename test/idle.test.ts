import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { IdleTracker, type IdleProbe } from "../src/idle.js";
import { Pacer, type SampleSink } from "../src/pacer.js";
import type { ProcCpu, ProcRow, SampleRecord } from "../src/types.js";

function row(pid: number, ppid: number, startSec = 1_700_000_000): ProcRow {
	return { pid, ppid, uid: 501, comm: `p${pid}`, startSec, startUsec: 0 };
}

/** A probe over a literal tree; descendants are the agent's children, transitively. */
class FakeProbe implements IdleProbe {
	rowsIn: ProcRow[] = [];
	usage = new Map<number, ProcCpu>();
	tracked = new Set<string>(); // "pid:startSec:startUsec" of members outside the tree
	constructor(readonly agentPid: number) {}

	descendants(): { key: string; pid: number; cpuS: number }[] {
		const byParent = new Map<number, ProcRow[]>();
		for (const r of this.rowsIn) byParent.set(r.ppid, [...(byParent.get(r.ppid) ?? []), r]);
		const out: { key: string; pid: number; cpuS: number }[] = [];
		const stack = [...(byParent.get(this.agentPid) ?? [])];
		while (stack.length > 0) {
			const r = stack.pop()!;
			out.push({ key: `${r.pid}:${r.startSec}:${r.startUsec}`, pid: r.pid, cpuS: this.cpuOf(r.pid) });
			stack.push(...(byParent.get(r.pid) ?? []));
		}
		return out;
	}
	cpuOf(pid: number): number {
		const ru = this.usage.get(pid);
		return ru ? ru.own + ru.reaped : 0;
	}
	trackedKeys(): Set<string> {
		return this.tracked;
	}
	row(pid: number): ProcRow | null {
		return this.rowsIn.find((r) => r.pid === pid) ?? null;
	}
}

describe("IdleTracker.check", () => {
	it("is busy during a turn", () => {
		const probe = new FakeProbe(100);
		const tracker = new IdleTracker(probe, () => true);
		assert.equal(tracker.check().idle, false);
		assert.equal(tracker.check().reason, "turn in progress");
	});

	it("is busy while a descendant burns CPU between checks", () => {
		const probe = new FakeProbe(100);
		probe.rowsIn = [row(101, 100)];
		probe.usage.set(101, { own: 1, reaped: 0 });
		const tracker = new IdleTracker(probe);
		assert.equal(tracker.check(0).idle, false); // a new descendant
		assert.equal(tracker.check(1_000).idle, true); // the same descendant, quiet
		probe.usage.set(101, { own: 1.5, reaped: 0 });
		assert.equal(tracker.check(1_500).idle, false); // 0.5 CPU-s over 0.5 s
	});

	it("goes idle when the descendants are the same and quiet", () => {
		const probe = new FakeProbe(100);
		probe.rowsIn = [row(101, 100), row(102, 101)];
		probe.usage.set(101, { own: 1, reaped: 0 });
		probe.usage.set(102, { own: 2, reaped: 0 });
		const tracker = new IdleTracker(probe);
		assert.equal(tracker.check(0).idle, false); // first look is not quiet yet
		assert.equal(tracker.check(30_000).idle, true);
	});

	it("is busy when a survivor grows while another descendant exits", () => {
		// The exited child's whole cumulative total drops out of the sum, which
		// would hide the survivor's growth and read as idle.
		const probe = new FakeProbe(100);
		probe.rowsIn = [row(101, 100), row(102, 100)];
		probe.usage.set(101, { own: 0.5, reaped: 0 });
		probe.usage.set(102, { own: 1, reaped: 0 });
		const tracker = new IdleTracker(probe);
		tracker.check(0);
		probe.rowsIn = [row(102, 100)];
		probe.usage.set(102, { own: 1.5, reaped: 0 });
		assert.equal(tracker.check(30_000).idle, false);
	});

	it("is busy while a tagged process outside the tree is alive", () => {
		const probe = new FakeProbe(100);
		probe.rowsIn = [row(300, 1)];
		probe.usage.set(300, { own: 7, reaped: 0 });
		probe.tracked = new Set(["300:1700000000:0"]);
		const tracker = new IdleTracker(probe);
		tracker.check(0);
		assert.equal(tracker.check(30_000).idle, false);
	});

	it("goes idle once that process is gone", () => {
		const probe = new FakeProbe(100);
		probe.tracked = new Set(["300:1700000000:0"]);
		const tracker = new IdleTracker(probe);
		assert.equal(tracker.check(0).idle, true);
	});

	it("reads a live pid as a live member, even after the pid changed hands", () => {
		// The kernel gives no stable start time on macOS 27, so a reused pid
		// reads as alive. That samples once more, which is the safe direction.
		const probe = new FakeProbe(100);
		probe.tracked = new Set(["300:1700000000:0"]);
		probe.rowsIn = [row(300, 1, 1_700_000_500)]; // same pid, later start
		probe.usage.set(300, { own: 7, reaped: 0 });
		const tracker = new IdleTracker(probe);
		assert.equal(tracker.check(0).idle, false);
	});

	it("never goes idle when the children cannot be listed", () => {
		class Blind extends FakeProbe {
			descendants(): null {
				return null;
			}
		}
		const tracker = new IdleTracker(new Blind(100));
		assert.equal(tracker.check(0).idle, false);
		assert.equal(tracker.check(30_000).reason, "cannot enumerate the agent's children");
	});
});

/** A sampler whose tick resolves only when the test says so. */
class GatedSampler {
	active = 0;
	maxActive = 0;
	private gates: Array<() => void> = [];
	tick(): Promise<SampleRecord> {
		this.active += 1;
		this.maxActive = Math.max(this.maxActive, this.active);
		return new Promise<SampleRecord>((resolve) => {
			this.gates.push(() => {
				this.active -= 1;
				resolve(record());
			});
		});
	}
	release(): void {
		this.gates.shift()?.();
	}
	get waiting(): number {
		return this.gates.length;
	}
}

let seq = 0;
function record(): SampleRecord {
	return {
		v: 1,
		ts: new Date().toISOString(),
		run: "r",
		seq: seq++,
		agent: "pi",
		session: "pi:s",
		cwd: "/w",
		agentPid: 100,
		intervalS: null,
		agentCpuS: 0,
		descendantCpuS: 0,
		taggedOrphanCpuS: 0,
		procs: [],
		procsTruncated: false,
		docker: { ok: true, stacks: [] },
		dockerVmCpuS: 0,
		dockerVmBoot: null,
		sampleCpuS: 0,
		sampleWallS: 0,
	};
}

describe("Pacer", () => {
	function pacerFor(sampler: GatedSampler, idle: () => boolean) {
		const appended: SampleRecord[] = [];
		const sink: SampleSink = (rec) => appended.push(rec);
		const tracker = { check: () => ({ idle: idle(), reason: idle() ? "quiet" : "turn" }) };
		return { pacer: new Pacer(sampler, sink, tracker), appended };
	}

	function deferred(): { promise: Promise<SampleRecord>; resolve: () => void } {
		let release: (rec: SampleRecord) => void = () => {};
		const promise = new Promise<SampleRecord>((resolve) => {
			release = resolve;
		});
		return { promise, resolve: () => release(record()) };
	}

	it("never overlaps two ticks", async () => {
		const first = deferred();
		const second = deferred();
		let calls = 0;
		let active = 0;
		let maxActive = 0;
		const sampler = {
			tick: () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				const d = calls++ === 0 ? first : second;
				return d.promise.finally(() => {
					active -= 1;
				});
			},
		};
		const tracker = { check: () => ({ idle: false, reason: "turn" }) };
		const pacer = new Pacer(sampler, () => {}, tracker);
		const a = pacer.tick();
		const b = pacer.tick();
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(calls, 1, "the second tick waits for the first");
		first.resolve();
		await a;
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(calls, 2);
		second.resolve();
		await b;
		assert.equal(maxActive, 1);
	});

	it("samples while busy and skips the sample once idle", async () => {
		let idle = false;
		const sampler = new GatedSampler();
		const { pacer, appended } = pacerFor(sampler, () => idle);
		const busy = pacer.tick();
		await Promise.resolve();
		sampler.release();
		await busy;
		assert.equal(appended.length, 1);

		idle = true;
		await pacer.tick();
		assert.equal(appended.length, 1);
		assert.equal(sampler.waiting, 0);
	});

	it("takes one sample on waking from idle", async () => {
		let idle = true;
		const sampler = new GatedSampler();
		const { pacer, appended } = pacerFor(sampler, () => idle);
		await pacer.tick();
		assert.equal(appended.length, 0);

		idle = false;
		const woken = pacer.wake();
		await Promise.resolve();
		sampler.release();
		await woken;
		assert.equal(appended.length, 1);
	});

	it("waits for an in-flight tick before the final sample on stop", async () => {
		const inflight = deferred();
		const final = deferred();
		let calls = 0;
		let active = 0;
		let maxActive = 0;
		const appended: SampleRecord[] = [];
		const sampler = {
			tick: () => {
				active += 1;
				maxActive = Math.max(maxActive, active);
				const d = calls++ === 0 ? inflight : final;
				return d.promise.finally(() => {
					active -= 1;
				});
			},
		};
		const tracker = { check: () => ({ idle: false, reason: "turn" }) };
		const pacer = new Pacer(sampler, (rec) => appended.push(rec), tracker);
		const ticked = pacer.tick();
		await Promise.resolve();
		const stopped = pacer.stop();
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(calls, 1, "the shutdown sample waits for the tick in flight");
		inflight.resolve();
		await ticked;
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(calls, 2);
		final.resolve();
		await stopped;
		assert.equal(maxActive, 1);
		assert.equal(appended.length, 2);
	});

	it("reports itself stopped once stop ran", async () => {
		const sampler = new GatedSampler();
		const { pacer } = pacerFor(sampler, () => false);
		assert.equal(pacer.isStopped, false);
		const ticked = pacer.tick();
		await Promise.resolve();
		sampler.release();
		await ticked;
		const stopped = pacer.stop();
		await Promise.resolve();
		sampler.release();
		await stopped;
		assert.equal(pacer.isStopped, true);
	});

	it("writes no final sample when the session was already idle", async () => {
		const sampler = new GatedSampler();
		const { pacer, appended } = pacerFor(sampler, () => true);
		await pacer.tick();
		await pacer.stop();
		assert.equal(appended.length, 0);
		assert.equal(sampler.maxActive, 0);
	});
});
