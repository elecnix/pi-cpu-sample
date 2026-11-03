/**
 * The real Linux backend, exercised against the running kernel. Skipped
 * everywhere else, so CI on Linux runs it and the macOS run skips it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { LinuxTable } from "../src/linux.js";
import { keyOf } from "../src/types.js";

const itLinux = process.platform === "linux" ? it : it.skip;

describe("LinuxTable (real OS)", () => {
	itLinux("gives a process a start time with sub-second resolution", () => {
		const rows = new LinuxTable().rows();
		assert.ok(rows && rows.length > 0, "the /proc table should be readable");
		const me = rows!.find((r) => r.pid === process.pid);
		assert.ok(me, "this process should be in the table");
		// The kernel gives start times in hundredths of a second, so a run has
		// rows whose microsecond part is not zero.
		assert.ok(rows!.some((r) => r.startUsec !== 0), "some start times carry a sub-second part");
	});

	itLinux("lists a child forked by a worker thread", async (t) => {
		// The task-level children file only covers one thread, so the union is
		// what makes this child visible.
		const { Worker } = await import("node:worker_threads");
		const worker = new Worker(
			`const { parentPort } = require("node:worker_threads");
			 const { spawn } = require("node:child_process");
			 parentPort.postMessage(spawn("/bin/sleep", ["5"], { stdio: "ignore" }).pid);`,
			{ eval: true },
		);
		const pid = await new Promise<number>((resolve) => worker.once("message", resolve));
		try {
			await new Promise((r) => setTimeout(r, 200));
			const tids = readdirSync(`/proc/${process.pid}/task`);
			const files = tids.map((tid) => {
				try {
					return [tid, readFileSync(`/proc/${process.pid}/task/${tid}/children`, "utf8").trim()];
				} catch {
					return [tid, "MISSING"];
				}
			});
			const listed = new LinuxTable().childPids(process.pid);
			t.diagnostic(JSON.stringify({ worker: pid, tids: tids.length, files, listed }));
			assert.ok(listed?.includes(pid), `the worker's child should be listed: ${JSON.stringify({ listed, files })}`);
		} finally {
			process.kill(pid, "SIGKILL");
			void worker.terminate();
		}
	});

	itLinux("keeps a process apart from a same-second namesake", () => {
		// A pid reused inside the same second must not share a key with its
		// previous holder, so the sub-second part has to reach the key.
		const rows = new LinuxTable().rows()!;
		const row = rows.find((r) => r.startUsec !== 0);
		assert.ok(row, "some start time should carry a sub-second part");
		assert.notEqual(keyOf({ ...row!, startUsec: 0 }), keyOf(row!));
	});
});
