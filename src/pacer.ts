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

/**
 * Run one unit of work after the last, whatever the last one did. A failure is
 * logged and swallowed: a throw from a tick must not become an unhandled
 * rejection that ends the agent's process.
 */
export function serialQueue(log: (message: string) => void): (work: () => Promise<void>) => Promise<void> {
	let tail: Promise<void> = Promise.resolve();
	return (work) => {
		const run = async () => {
			try {
				await work();
			} catch (err) {
				log(`tick failed: ${err instanceof Error ? err.message : err}`);
			}
		};
		tail = tail.then(run, run);
		return tail;
	};
}

/** The part of Sampler that the pacer drives. */
export interface Tickable {
	tick(): Promise<SampleRecord>;
}

export class Pacer {
	private readonly enqueue: (work: () => Promise<void>) => Promise<void>;
	private stopped = false;
	/** True once a full sample has been taken since the session was last idle. */
	private active = true;

	constructor(
		private sampler: Tickable,
		private sink: SampleSink,
		private tracker: Pick<IdleTracker, "check">,
		private log: (message: string) => void = () => {},
		/** False while sampling is switched off; the timer keeps running. */
		private enabled: () => boolean = () => true,
	) {
		this.enqueue = serialQueue(log);
	}

	/** One timer tick: sample while busy, skip the sample while idle. */
	tick(): Promise<void> {
		return this.enqueue(async () => {
			if (this.stopped || !this.enabled()) return;
			const verdict = this.tracker.check();
			if (verdict.idle) {
				// The turn ended after the last sample. One more sample covers its
				// tail; without it, shutdown skips the interval entirely.
				if (this.active) {
					await this.sample();
					this.log(`paused: ${verdict.reason}`);
				}
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
			if (this.stopped || !this.enabled()) return;
			const verdict: IdleVerdict = { idle: false, reason: "turn started" };
			if (verdict.idle) return;
			await this.sample();
			this.active = true;
		});
	}

	/**
	 * Stop the cadence and write the final sample, unless the session was idle
	 * or sampling is switched off. The kill switch covers the shutdown sample
	 * too, so nothing reaches the session once sampling is off.
	 */
	stop(): Promise<void> {
		this.stopped = true;
		return this.enqueue(async () => {
			if (!this.active || !this.enabled()) return;
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

}
