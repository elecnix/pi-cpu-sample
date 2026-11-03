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

	descendants(): { key: string; pid: number; cpuS: number }[] | null {
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

	it("is busy after a long gap with real work in it", () => {
		// The rate is averaged over a normal check, not over a ten-minute gap
		// that would let a burst sit under the threshold.
		const probe = new FakeProbe(100);
		probe.rowsIn = [row(101, 100)];
		probe.usage.set(101, { own: 1, reaped: 0 });
		const tracker = new IdleTracker(probe);
		tracker.check(0);
		probe.usage.set(101, { own: 2, reaped: 0 }); // 1 CPU-s over 600 s
		assert.equal(tracker.check(600_000).idle, false);
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
	function deferred(): { promise: Promise<SampleRecord>; resolve: () => void } {
		let release: (rec: SampleRecord) => void = () => {};
		const promise = new Promise<SampleRecord>((resolve) => {
			release = resolve;
		});
		return { promise, resolve: () => release(record()) };
	}

	/** A pacer over a sampler that answers one deferred per tick, with a switchable verdict. */
	function rig() {
		const sampler = {
			pending: [] as Array<() => void>,
			live: 0,
			maxLive: 0,
			tick(): Promise<SampleRecord> {
				this.live += 1;
				this.maxLive = Math.max(this.maxLive, this.live);
				return new Promise<SampleRecord>((resolve) => {
					this.pending.push(() => {
						this.live -= 1;
						resolve(record());
					});
				});
			},
			release(): void {
				this.pending.shift()?.();
			},
			get waiting(): number {
				return this.pending.length;
			},
		};
		const state = { idle: false };
		const appended: SampleRecord[] = [];
		const tracker = { check: () => ({ idle: state.idle, reason: state.idle ? "quiet" : "turn" }) };
		const pacer = new Pacer(sampler, (rec) => appended.push(rec), tracker);
		return { sampler, state, appended, pacer };
	}

	it("never overlaps two ticks", async () => {
		const r = rig();
		const a = r.pacer.tick();
		const b = r.pacer.tick();
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(r.sampler.pending.length, 1, "the second tick waits for the first");
		r.sampler.release();
		await a;
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(r.sampler.pending.length, 1);
		r.sampler.release();
		await b;
		assert.equal(r.sampler.maxLive, 1);
	});

	it("samples while busy", async () => {
		const r = rig();
		const ticked = r.pacer.tick();
		await Promise.resolve();
		assert.equal(r.sampler.waiting, 1);
		r.sampler.release();
		await ticked;
		assert.equal(r.appended.length, 1);
	});

	it("writes one last sample when the turn ends, then pauses", async () => {
		const r = rig();
		const busy = r.pacer.tick();
		await Promise.resolve();
		r.sampler.release();
		await busy;
		assert.equal(r.appended.length, 1);

		// The turn ended after that sample: the sample covering its tail is
		// written before the pause.
		r.state.idle = true;
		const idleTick = r.pacer.tick();
		await Promise.resolve();
		assert.equal(r.sampler.waiting, 1);
		r.sampler.release();
		await idleTick;
		assert.equal(r.appended.length, 2);

		// Paused now: a later idle tick writes nothing.
		await r.pacer.tick();
		assert.equal(r.appended.length, 2);
	});

	it("samples at once on waking from idle", async () => {
		const r = rig();
		r.state.idle = true;
		const base = r.pacer.tick(); // the baseline sample, then pause
		await Promise.resolve();
		r.sampler.release();
		await base;
		assert.equal(r.appended.length, 1);
		await r.pacer.tick(); // paused
		assert.equal(r.appended.length, 1);

		r.state.idle = false;
		const woken = r.pacer.wake();
		await Promise.resolve();
		r.sampler.release();
		await woken;
		assert.equal(r.appended.length, 2);
	});

	it("waits for an in-flight tick before the final sample on stop", async () => {
		const r = rig();
		const ticked = r.pacer.tick();
		await Promise.resolve();
		const stopped = r.pacer.stop();
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(r.sampler.waiting, 1, "the shutdown sample waits for the tick in flight");
		r.sampler.release();
		await ticked;
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(r.sampler.waiting, 1);
		r.sampler.release();
		await stopped;
		assert.equal(r.sampler.maxLive, 1);
		assert.equal(r.appended.length, 2);
	});

	it("writes one more sample when the turn ends during a sample", async () => {
		const r = rig();
		let checks = 0;
		// Busy on the first check, idle once the sample has run.
		const tracker = { check: () => (checks++ === 0 ? { idle: false, reason: "turn" } : { idle: true, reason: "quiet" }) };
		const pacer = new Pacer(r.sampler, (rec) => r.appended.push(rec), tracker);
		const ticked = pacer.tick();
		await Promise.resolve();
		r.sampler.release(); // the first sample
		await Promise.resolve();
		await Promise.resolve();
		assert.equal(r.appended.length, 1);
		assert.equal(r.sampler.waiting, 1, "the second sample starts once the first resolves");
		r.sampler.release();
		await ticked;
		assert.equal(r.appended.length, 2);
	});

	it("reports itself stopped once stop ran", async () => {
		const r = rig();
		assert.equal(r.pacer.isStopped, false);
		const ticked = r.pacer.tick();
		await Promise.resolve();
		r.sampler.release();
		await ticked;
		const stopped = r.pacer.stop();
		await Promise.resolve();
		r.sampler.release();
		await stopped;
		assert.equal(r.pacer.isStopped, true);
	});

	it("writes no final sample when the session was already idle", async () => {
		const r = rig();
		r.state.idle = true;
		const base = r.pacer.tick(); // the baseline, then pause
		await Promise.resolve();
		r.sampler.release();
		await base;
		const before = r.appended.length;
		const stopped = r.pacer.stop();
		await stopped;
		assert.equal(r.appended.length, before);
	});
});
