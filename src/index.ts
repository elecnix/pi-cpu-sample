/**
 * The pi extension: register this session with the machine-wide sampler, lead
 * it while this process holds the owner lock, and follow another owner
 * otherwise. One `cpu-sample` entry lands in this session's transcript per new
 * record, about every 30 seconds while the session works.
 *
 * Sampling costs one machine-wide pass per tick on whichever session owns the
 * lock, and one registration write per tick on every other session. The first
 * sample after waking carries the cumulative counters across the gap, so a
 * pause costs no accuracy.
 *
 * When the shared cache cannot be used, the session falls back to the sampler
 * this extension used to run inside its own process. Then a session's
 * `agent_cpu_s` includes the sampler's own cost (each record carries the exact
 * figure in `sample_cpu_s`), as before.
 */

import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import type { ExtensionAPI, ExtensionContext } from "./pi-stubs.js";
import { createTable } from "./backend.js";
import { Pacer } from "./pacer.js";
import { DockerClient } from "./docker.js";
import { IdleTracker } from "./idle.js";
import { disableDir, killSwitchActive } from "./killswitch.js";
import { Sampler } from "./sample.js";
import { createSessionDriver, StandaloneSession, type SessionDriver } from "./client.js";
import { cachePaths, defaultCacheDir } from "./registry.js";

const INTERVAL_MS = 30_000;

/** The SIGURG handler is installed once per process, however often pi reloads. */
let signalHooked = false;
/**
 * The driver a wake nudge reaches. It lives at module scope, so the handler
 * installed by an earlier invocation of the extension still finds the session
 * running after a reload.
 */
let signalTarget: { tick(): Promise<void> } | null = null;

export default function (pi: ExtensionAPI) {
	/** The driver of the running session, or null between sessions. */
	let current: SessionDriver | null = null;
	let liveCtx: ExtensionContext | null = null;
	let liveSessionId: string | null = null;
	let timer: ReturnType<typeof setInterval> | null = null;
	let turnOpen = false;
	let wakeScheduled = false;

	const killSwitchOff = () => !killSwitchActive({ dir: disableDir(homedir()), env: process.env });
	const log = (message: string) => console.error(`[pi-cpu-sample] ${message}`);

	// A wake nudge from another session's client lands here when this process
	// holds the owner lock, so the turn's first sample is not half a minute late.
	if (!signalHooked) {
		signalHooked = true;
		try {
			process.on("SIGURG", () => void signalTarget?.tick());
		} catch {
			// A platform without SIGURG simply waits for the next timer tick.
		}
	}

	pi.on("agent_start", () => {
		turnOpen = true;
		if (!current || wakeScheduled) return;
		// A session that was idle starts sampling again at once, so the turn's
		// first sample is not half a minute late. The microtask batches several
		// events of one keystroke into one sample.
		wakeScheduled = true;
		queueMicrotask(() => {
			wakeScheduled = false;
			current?.wake();
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
			log(`no process table for ${process.platform}; not sampling`);
			return;
		}
		const cwd = ctx.cwd;
		const docker = new DockerClient();
		liveCtx = ctx;
		liveSessionId = sessionId;
		turnOpen = false; // a new session begins with no open turn
		const inTurn = () => turnOpen || liveCtx?.isIdle() === false;
		const driver = createSessionDriver({
			paths: cachePaths(process.env.CPU_SAMPLE_CACHE_DIR ?? defaultCacheDir(homedir())),
			identity: { session, agent: "pi", agentPid: process.pid, clientPid: process.pid, cwd },
			table,
			docker: () => docker.listAll(),
			deliver: (rec) => pi.appendEntry("cpu-sample", rec),
			inTurn,
			enabled: killSwitchOff,
			log,
			standalone: () => {
				// The fallback: sample this one tree inside this process, exactly as
				// the extension did before the shared sampler existed.
				const sampler = new Sampler({
					table,
					docker: () => docker.listUnder(cwd),
					agentPid: process.pid,
					agent: "pi",
					session,
					cwd,
					runId: randomUUID(),
					selfPid: -1,
				});
				const tracker = new IdleTracker(sampler, inTurn);
				return new StandaloneSession(
					new Pacer(sampler, (rec) => pi.appendEntry("cpu-sample", rec), tracker, log, killSwitchOff),
				);
			},
		});
		timer = setInterval(() => void driver.tick(), INTERVAL_MS);
		timer.unref();
		current = driver;
		signalTarget = driver;
		// The first sample is the baseline; every later sample subtracts from it.
		void driver.tick();
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
		const driver = current;
		try {
			// A final record, unless sampling is switched off. Either way the
			// driver removes its registration and gives the lock back.
			if (driver) await driver.stop();
		} finally {
			// stop() awaits an in-flight tick, which can include a Docker read. A
			// session started during that await owns a new driver, and this
			// handler must not clear it.
			turnOpen = false;
			if (signalTarget === driver) signalTarget = null;
			if (current === driver) {
				current = null;
				liveCtx = null;
				liveSessionId = null;
			}
		}
	});
}
