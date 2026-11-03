/**
 * The pi extension: start a sampler on session_start, append one cumulative
 * `cpu-sample` entry every 30 seconds while the session works, and stop on
 * session_shutdown.
 *
 * Sampling stops while the session is idle, because fifty idle sessions should
 * cost fifty idle sessions, not fifty samplers. The first sample after waking
 * carries the cumulative counters across the gap, so a pause costs no accuracy.
 *
 * Sampling runs inside the pi process, so a session's `agent_cpu_s` includes
 * the sampler's own cost (each record carries the exact figure in
 * `sample_cpu_s`).
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "./pi-stubs.js";
import { createTable } from "./backend.js";
import { DockerClient } from "./docker.js";
import { IdleTracker } from "./idle.js";
import { disableDir, killSwitchActive } from "./killswitch.js";
import { Pacer } from "./pacer.js";
import { Sampler } from "./sample.js";

const INTERVAL_MS = 30_000;

export default function (pi: ExtensionAPI) {
	/** The pacer of the running session, or null between sessions. */
	let current: Pacer | null = null;
	let liveCtx: ExtensionContext | null = null;
	let liveSessionId: string | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	let turnOpen = false;
	let wakeScheduled = false;

	pi.on("agent_start", () => {
		turnOpen = true;
		if (!current || wakeScheduled) return;
		// A session that was idle starts sampling again at once, so the turn's
		// first sample is not half a minute late. The microtask batches several
		// events of one keystroke into one sample.
		wakeScheduled = true;
		queueMicrotask(() => {
			wakeScheduled = false;
			void current?.wake();
		});
	});
	pi.on("agent_settled", () => {
		turnOpen = false;
	});

	pi.on("session_start", (_event, ctx) => {
		if (current && !current.isStopped) return; // this instance already runs one
		if (killSwitchActive({ dir: disableDir(homedir()), env: process.env })) return;
		const sessionId = ctx.sessionManager.getSessionId();
		const session = `pi:${sessionId}`;
		process.env.CPU_SAMPLE_SESSION = session;
		const table = createTable();
		if (!table) {
			console.error(`[pi-cpu-sample] no process table for ${process.platform}; not sampling`);
			return;
		}
		const cwd = ctx.cwd;
		const docker = new DockerClient();
		const sampler = new Sampler({
			table,
			docker: () => docker.listUnder(cwd),
			agentPid: process.pid,
			agent: "pi",
			session,
			cwd,
			runId: randomUUID(),
			selfPid: -1, // sampling is in-process: the agent's own CPU is counted
		});
		liveCtx = ctx;
		liveSessionId = sessionId;
		turnOpen = false; // a new session begins with no open turn
		// pi answers for itself whether a run or a compaction is active. The
		// event flag covers the gaps: before the first agent_start of a reload,
		// and after agent_settled but before the next turn begins.
		const tracker = new IdleTracker(sampler, () => turnOpen || liveCtx?.isIdle() === false);
		const log = (message: string) => console.error(`[pi-cpu-sample] ${message}`);
		const pacer = new Pacer(
			sampler,
			(rec) => pi.appendEntry("cpu-sample", rec),
			tracker,
			log,
			// The kill switch takes effect at the next tick, and removing it
			// resumes sampling, because the timer keeps running either way.
			() => !killSwitchActive({ dir: disableDir(homedir()), env: process.env }),
		);
		timer = setInterval(() => void pacer.tick(), INTERVAL_MS);
		timer.unref();
		current = pacer;
		// The first sample is the baseline; every later sample subtracts from it.
		void pacer.tick();
	});

	// Registered once, so a second session in the same process cannot stack
	// another copy of it beside the first.
	pi.on("session_shutdown", async (_event, ctx) => {
		// A shutdown for another session must leave the running one alone.
		const shuttingId = ctx?.sessionManager?.getSessionId?.() ?? null;
		if (shuttingId !== null && liveSessionId !== null && shuttingId !== liveSessionId) return;
		if (timer) clearInterval(timer);
		timer = null;
		delete process.env.CPU_SAMPLE_SESSION;
		const pacer = current;
		const liveSessionCtx = liveCtx;
		try {
			if (pacer && !killSwitchActive({ dir: disableDir(homedir()), env: process.env })) await pacer.stop();
		} finally {
			// stop() awaits an in-flight tick, which can include a Docker read. A
			// session started during that await owns a new pacer, and this
			// handler must not clear it.
			// A session that ends mid-turn must not leave the next one looking
			// busy. This runs whatever owns the slot by now, because the next
			// session's pacer may already have been installed during the await.
			turnOpen = false;
			if (current === pacer) {
				current = null;
				liveCtx = null;
				liveSessionId = null;
			}
		}
	});
}
