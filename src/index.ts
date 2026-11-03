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
import type { ExtensionAPI } from "./pi-stubs.js";
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
		const tracker = new IdleTracker(sampler);
		const log = (message: string) => console.error(`[pi-cpu-sample] ${message}`);
		const pacer = new Pacer(sampler, (rec) => pi.appendEntry("cpu-sample", rec), tracker, log);
		const timer = setInterval(() => void pacer.tick(), INTERVAL_MS);
		timer.unref();
		current = pacer;
		tracker.busy = turnOpen;
		// The first sample is the baseline; every later sample subtracts from it.
		void pacer.tick();

		pi.on("session_shutdown", async () => {
			clearInterval(timer);
			delete process.env.CPU_SAMPLE_SESSION;
			try {
				if (!killSwitchActive({ dir: disableDir(homedir()), env: process.env })) await pacer.stop();
			} finally {
				// A stopped pacer must not block the next session's start if this
				// instance sees one before its shutdown returns.
				if (current === pacer) current = null;
			}
		});
	});
}
