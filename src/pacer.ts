/**
 * The sample cadence. One chain runs every tick, every wake and the shutdown
 * sample, so two ticks never overlap and the shutdown sample waits for the one
 * in flight.
 *
 * While the session is idle the full sample is skipped, because nothing changes
 * in it. The first sample after waking carries the cumulative counters across
 * the idle gap, so the gaps cost no accuracy.
 */

import type { IdleVerdict, IdleTracker } from "./idle.js";
import type { SampleRecord } from "./types.js";

export type SampleSink = (record: SampleRecord) => void;

/** The part of Sampler that the pacer drives. */
export interface Tickable {
	tick(): Promise<SampleRecord>;
}

export class Pacer {
	private tail: Promise<void> = Promise.resolve();
	private stopped = false;
	/** True once a full sample has been taken since the session was last idle. */
	private active = true;

	constructor(
		private sampler: Tickable,
		private sink: SampleSink,
		private tracker: Pick<IdleTracker, "check">,
		private log: (message: string) => void = () => {},
	) {}

	/** One timer tick: sample while busy, skip the sample while idle. */
	tick(): Promise<void> {
		return this.enqueue(async () => {
			if (this.stopped) return;
			const verdict = this.tracker.check();
			if (verdict.idle) {
				if (this.active) this.log(`paused: ${verdict.reason}`);
				this.active = false;
				return;
			}
			await this.sample();
			this.active = true;
			// The turn may have ended during the sample. Writing one more
			// cumulative sample here makes the idle gap start at the exact
			// moment the session stopped working.
			const after = this.tracker.check();
			if (after.idle) {
				await this.sample();
				this.log(`paused: ${after.reason}`);
				this.active = false;
			}
		});
	}

	/** A turn started: sample at once, so the counters cover the idle gap. */
	wake(): Promise<void> {
		return this.enqueue(async () => {
			if (this.stopped) return;
			const verdict: IdleVerdict = { idle: false, reason: "turn started" };
			if (verdict.idle) return;
			await this.sample();
			this.active = true;
		});
	}

	/** Stop the cadence and write the final sample, unless the session was idle. */
	stop(): Promise<void> {
		this.stopped = true;
		return this.enqueue(async () => {
			if (!this.active) return;
			await this.sample();
			this.active = false;
		});
	}

	/** True once stop() ran; the caller's kill switch keeps the timer alive only before this. */
	get isStopped(): boolean {
		return this.stopped;
	}

	private async sample(): Promise<void> {
		try {
			this.sink(await this.sampler.tick());
		} catch (err) {
			this.log(`tick failed: ${err instanceof Error ? err.message : err}`);
		}
	}

	private enqueue(work: () => Promise<void>): Promise<void> {
		this.tail = this.tail.then(work, work);
		return this.tail;
	}
}
