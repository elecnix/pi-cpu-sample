/**
 * The pi extension: start a sampler on session_start, append one cumulative
 * `cpu-sample` entry every 30 seconds, stop on session_shutdown.
 *
 * Sampling runs inside the pi process, so a session's `agent_cpu_s` includes
 * the sampler's own cost (about 0.2 CPU-seconds per 30 s tick on a busy Mac;
 * each record carries the exact figure in `sample_cpu_s`).
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { ExtensionAPI } from "./pi-stubs.js";
import { createTable } from "./backend.js";
import { DockerClient } from "./docker.js";
import { disableDir, killSwitchActive } from "./killswitch.js";
import { Sampler } from "./sample.js";

const INTERVAL_MS = 30_000;

export default function (pi: ExtensionAPI) {
	pi.on("session_start", (_event, ctx) => {
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
		let stopped = false;
		const emit = async () => {
			if (stopped) return;
			if (killSwitchActive({ dir: disableDir(homedir()), env: process.env })) return; // idle, keep the timer
			try {
				const rec = await sampler.tick();
				pi.appendEntry("cpu-sample", rec);
			} catch (err) {
				console.error(`[pi-cpu-sample] tick failed: ${err instanceof Error ? err.message : err}`);
			}
		};
		void emit();
		const timer = setInterval(() => void emit(), INTERVAL_MS);
		timer.unref();
		pi.on("session_shutdown", async () => {
			stopped = true;
			clearInterval(timer);
			delete process.env.CPU_SAMPLE_SESSION;
			if (killSwitchActive({ dir: disableDir(homedir()), env: process.env })) return;
			try {
				const rec = await sampler.tick();
				pi.appendEntry("cpu-sample", rec);
			} catch {
				// The session is going away; nothing to report to.
			}
		});
	});
}
