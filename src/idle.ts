/**
 * Idle detection: decides whether a session is doing any work without reading
 * the whole process table and without asking Docker.
 *
 * The check runs once per timer tick in both states, so it also decides when a
 * paused sampler resumes. It reads the agent's descendants through one kernel
 * call per process, and the members that left the tree through a per-pid row
 * lookup. See the README for its measured cost.
 */

import type { ProcRow } from "./types.js";

/** What the check can learn about the session, in the cheap form. */
export interface IdleProbe {
	/**
	 * The agent's live descendants, with their cumulative CPU, or null when the
	 * platform cannot enumerate them. Null never means idle: a sampler that
	 * cannot see the children cannot claim they are quiet.
	 */
	descendants(): { key: string; pid: number; cpuS: number }[] | null;
	/** Keys of session members outside the agent's tree, as of the last sample. */
	trackedKeys(): Set<string>;
	/** Cumulative CPU of one live pid. */
	cpuOf(pid: number): number;
	/** The row for one live pid, or null when it is gone. */
	row(pid: number): ProcRow | null;
}

export interface IdleVerdict {
	/** True when the session is idle: the sample can be skipped. */
	idle: boolean;
	/** Why the session is busy, for the log line. */
	reason: string;
}

const DEFAULT_MAX_IDLE_RATE = 0.005;
/** CPU-s a descendant must use in one check before the session counts as busy. */
const MIN_BUSY_CPU_S = 0.05;

export class IdleTracker {
	private last: Map<string, number> | null = null;
	private lastMs = 0;

	constructor(
		private probe: IdleProbe,
		/** True while the agent runs a turn; the extension reads the live answer from pi. */
		private inTurn: () => boolean = () => false,
		/** CPU cores a descendant may use, averaged over a check, and still be idle. */
		private maxIdleRate = DEFAULT_MAX_IDLE_RATE,
	) {}

	check(nowMs: number = Date.now()): IdleVerdict {
		if (this.inTurn()) {
			this.snapshot(this.probe.descendants() ?? [], nowMs);
			return { idle: false, reason: "turn in progress" };
		}
		const alive = this.aliveOutsideTree();
		const descendants = this.probe.descendants();
		if (descendants === null) return { idle: false, reason: "cannot enumerate the agent's children" };
		const elapsedS = this.last === null ? 0 : Math.max(0, (nowMs - this.lastMs) / 1000);
		const previous = this.last;
		const fresh = previous === null ? descendants.length > 0 : descendants.some((d) => !previous.has(d.key));
		// Growth per surviving process. A descendant that exits removes its whole
		// cumulative total from a plain sum, and that subtraction would cancel a
		// survivor's work.
		let grew = 0;
		if (previous !== null) {
			for (const d of descendants) {
				const before = previous.get(d.key);
				if (before !== undefined && d.cpuS > before) grew += d.cpuS - before;
			}
		}
		this.snapshot(descendants, nowMs);
		if (fresh) return { idle: false, reason: "new descendant" };
		// Both a floor and a rate: a quick check after waking has no time to
		// average over, and a long idle gap must not excuse a burst.
		if (previous !== null && grew > MIN_BUSY_CPU_S && grew > elapsedS * this.maxIdleRate) {
			return { idle: false, reason: `descendants used ${grew.toFixed(2)} CPU-s` };
		}
		if (alive !== null) return { idle: false, reason: `pid ${alive} outside the tree is alive` };
		if (descendants.length === 0) return { idle: true, reason: "no descendants" };
		return { idle: true, reason: "quiet" };
	}

	/** A session member outside the tree whose pid still names the same process. */
	private aliveOutsideTree(): number | null {
		for (const key of this.probe.trackedKeys()) {
			const [pidText] = key.split(":");
			// Liveness only. macOS 27 answers neither the pid nor a stable start
			// time for a single process, so the start time cannot confirm that a
			// reused pid is the member this session recorded. A reused pid reads
			// as alive and costs one sample, which is the safe direction.
			const row = this.probe.row(Number(pidText));
			if (row) return row.pid;
		}
		return null;
	}

	private snapshot(descendants: { key: string; cpuS: number }[], nowMs: number): void {
		this.last = new Map(descendants.map((d) => [d.key, d.cpuS]));
		this.lastMs = nowMs;
	}
}
