/**
 * Cost of the shared sampler. Numbers feed the README and the pull request.
 *
 * Run with `npm run bench:shared`. Three measurements:
 *
 * 1. One owner tick that samples every registered session, with 1, 20 and 100
 *    sessions, Docker stubbed and Docker live. The process table is this
 *    machine's real one; only the registrations and the session trees are
 *    synthetic, and the sessions share a few quiet processes so the per-session
 *    walk stays realistic without spawning a hundred shells.
 * 2. The per-session cost of being a contender: one registration write, one
 *    lock read, and one result read, with another owner holding the lock.
 * 3. One owner tick when every session is idle: the resume check only.
 *
 * For comparison it also measures the old shape, one in-process sampler per
 * session, with Docker stubbed.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerClient } from "../src/docker.js";
import { createTable } from "../src/backend.js";
import { Owner } from "../src/owner.js";
import { Sampler } from "../src/sample.js";
import { SharedClient } from "../src/client.js";
import { cachePaths, writeEntry, type RegistryEntry } from "../src/registry.js";
import { LOCK_VERSION, tryAcquire } from "../src/lockfile.js";
import type { RawDockerSnapshot } from "../src/ledger.js";
import type { ProcTable } from "../src/types.js";

const TICKS_PER_HOUR = 3600 / 30;
const MEASURED_TICKS = 20;
const COUNTS = [1, 20, 100];

const table = createTable();
if (table === null) {
	console.error(`no process table for ${process.platform}`);
	process.exit(1);
}

const root = join(tmpdir(), `cpu-sample-bench-${process.pid}`);
mkdirSync(root, { recursive: true });

/** A few quiet processes whose trees the synthetic sessions share. */
const helpers: ChildProcess[] = [];
for (let i = 0; i < 3; i++) helpers.push(spawn("sleep", ["3600"], { stdio: "ignore" }));
const pidPool = [process.pid, ...helpers.map((h) => h.pid!).filter((pid) => pid > 0)];

const stubDocker = async (): Promise<RawDockerSnapshot> => ({
	ok: true,
	containers: [
		{ id: "c1", project: "bench-a", dir: "/tmp/bench-project-a", cpuS: 1 },
		{ id: "c2", project: "bench-b", dir: "/tmp/bench-project-b", cpuS: 2 },
		{ id: "c3", project: "bench-c", dir: "/tmp/bench-project-c", cpuS: 3 },
	],
});
const liveDocker = () => new DockerClient().listAll();

function entry(i: number, busy: boolean): RegistryEntry {
	const agentPid = pidPool[i % pidPool.length]!;
	return {
		v: 1,
		key: `pi-bench-${i}`,
		session: `pi:bench-${i}`,
		agent: "pi",
		agentPid,
		clientPid: agentPid,
		cwd: "/tmp",
		busy,
		beat: Date.now(),
		deliveredRun: null,
		deliveredSeq: -1,
	};
}

function describe(label: string, msPerTick: number, sessions: number): void {
	const secondsPerHour = (msPerTick / 1000) * TICKS_PER_HOUR;
	const perSessionUs = (msPerTick * 1000) / sessions;
	console.log(
		`${label.padEnd(46)} ${msPerTick.toFixed(2).padStart(8)} ms/tick  ${secondsPerHour
			.toFixed(2)
			.padStart(7)} CPU-s/h  ${perSessionUs.toFixed(0).padStart(5)} us/session`,
	);
}

async function measureOwner(
	label: string,
	sessions: number,
	docker: () => Promise<RawDockerSnapshot>,
	busy: boolean,
): Promise<number> {
	const paths = cachePaths(join(root, `${label.replace(/\W+/g, "-")}-${sessions}`));
	for (let i = 0; i < sessions; i++) writeEntry(paths, entry(i, busy));
	const identity = { pid: process.pid, key: "bench", token: `bench-${sessions}` };
	if (!tryAcquire(paths, identity, Date.now(), () => true)) throw new Error("lock not acquired");
	const owner = new Owner({ paths, table: table!, docker, identity, now: Date.now, isAlive: () => true });
	// One warm-up tick pays for the first environment scan and the JIT.
	await owner.pass();
	const before = process.cpuUsage();
	const wall = performance.now();
	for (let i = 0; i < MEASURED_TICKS; i++) await owner.pass();
	const spent = process.cpuUsage(before);
	const cpuMsPerTick = (spent.user + spent.system) / 1000 / MEASURED_TICKS;
	console.log(
		`${label.padEnd(46)} ${cpuMsPerTick.toFixed(2).padStart(8)} ms CPU/tick  wall ${(
			(performance.now() - wall) /
			MEASURED_TICKS
		).toFixed(2)} ms`,
	);
	return cpuMsPerTick;
}

async function measureIdle(sessions: number): Promise<number> {
	const label = `owner idle tick, ${sessions} sessions`;
	const paths = cachePaths(join(root, `idle-${sessions}`));
	for (let i = 0; i < sessions; i++) writeEntry(paths, entry(i, false));
	const identity = { pid: process.pid, key: "bench", token: `idle-${sessions}` };
	if (!tryAcquire(paths, identity, Date.now(), () => true)) throw new Error("lock not acquired");
	const owner = new Owner({ paths, table: table!, docker: stubDocker, identity, now: Date.now, isAlive: () => true });
	for (let i = 0; i < 6; i++) {
		const result = await owner.pass();
		if (result.kind === "idle") break;
	}
	const before = process.cpuUsage();
	for (let i = 0; i < MEASURED_TICKS; i++) await owner.pass();
	const spent = process.cpuUsage(before);
	return (spent.user + spent.system) / 1000 / MEASURED_TICKS;
}

async function measureContender(): Promise<number> {
	const paths = cachePaths(join(root, "contender"));
	mkdirSync(paths.root, { recursive: true });
	writeEntry(paths, entry(0, false));
	// Another live owner holds the lock. Its beat is far in the future, so the
	// contender never sees it go stale during the measurement.
	writeFileSync(
		paths.lockFile,
		JSON.stringify({ v: LOCK_VERSION, pid: process.pid + 1, key: "other", token: "other", beat: Date.now() + 1e9 }),
	);
	const client = new SharedClient({
		paths,
		identity: { session: "pi:bench-0", agent: "pi", agentPid: pidPool[0]!, clientPid: pidPool[0]!, cwd: "/tmp" },
		table: table!,
		docker: stubDocker,
		deliver: () => {},
		inTurn: () => false,
		now: Date.now,
		isAlive: () => true,
		token: "contender",
	});
	await client.tick();
	const before = process.cpuUsage();
	for (let i = 0; i < MEASURED_TICKS * 10; i++) await client.tick();
	const spent = process.cpuUsage(before);
	return (spent.user + spent.system) / 1000 / (MEASURED_TICKS * 10);
}

/** The old shape: each session samples this machine in its own process. */
async function measureOldPerSession(): Promise<number> {
	const sampler = new Sampler({
		table: table!,
		docker: async () => ({ ok: false, containers: [] }),
		agentPid: process.pid,
		agent: "pi",
		session: "pi:bench-old",
		cwd: "/tmp",
		runId: "bench",
		selfPid: -1,
	});
	await sampler.tick();
	const before = process.cpuUsage();
	for (let i = 0; i < MEASURED_TICKS; i++) await sampler.tick();
	const spent = process.cpuUsage(before);
	return (spent.user + spent.system) / 1000 / MEASURED_TICKS;
}

try {
	console.log(`process table: ${table.rows()?.length ?? 0} rows, helper pids ${pidPool.join(", ")}\n`);

	console.log("One owner tick for every registered session, Docker stubbed out");
	for (const sessions of COUNTS) {
		const ms = await measureOwner("owner full pass, stub docker", sessions, stubDocker, true);
		describe(`  ${sessions} sessions`, ms, sessions);
	}

	console.log("\nOne owner tick for every registered session, Docker live");
	const probe = await liveDocker();
	console.log(`  docker ${probe.ok ? `answered with ${probe.containers.length} containers` : "did not answer"}`);
	for (const sessions of COUNTS) {
		const ms = await measureOwner("owner full pass, live docker", sessions, liveDocker, true);
		describe(`  ${sessions} sessions`, ms, sessions);
	}

	console.log("\nEvery session idle: the resume check alone");
	for (const sessions of COUNTS) {
		const ms = await measureIdle(sessions);
		describe(`  ${sessions} sessions`, ms, sessions);
	}

	console.log("\nContender");
	const contenderMs = await measureContender();
	console.log(
		`${"one contender tick".padEnd(46)} ${(contenderMs * 1000).toFixed(0).padStart(8)} us/tick  ${(
			(contenderMs / 1000) *
			TICKS_PER_HOUR
		).toFixed(4)} CPU-s/h`,
	);

	console.log("\nThe old shape, for comparison");
	const oldMs = await measureOldPerSession();
	console.log(`${"one in-process sampler tick, stub docker".padEnd(46)} ${oldMs.toFixed(2)} ms`);
	console.log(
		`${"  same cost at 100 sessions".padEnd(46)} ${(oldMs * 100).toFixed(0)} ms/tick  ${(
			(oldMs / 1000) *
			TICKS_PER_HOUR *
			100
		).toFixed(1)} CPU-s/h`,
	);
} finally {
	for (const helper of helpers) {
		if (helper.pid) {
			try {
				process.kill(helper.pid, "SIGTERM");
			} catch {
				// Already gone.
			}
		}
	}
	rmSync(root, { recursive: true, force: true });
}

// Keep the type import used for documentation purposes.
export type { ProcTable };
