/**
 * The real macOS backend, exercised against the running operating system.
 * Skipped everywhere else, so CI on Linux still runs the whole suite.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { MacOSTable } from "../src/macos.js";

const itMac = process.platform === "darwin" ? it : it.skip;

describe("MacOSTable (real OS)", () => {
	itMac("finds this process with a plausible parent and start time", () => {
		const table = new MacOSTable();
		const rows = table.rows();
		assert.ok(rows, "the kernel process table should be readable");
		const me = rows!.find((r) => r.pid === process.pid);
		assert.ok(me, "this process should be in the table");
		assert.equal(me!.ppid, process.ppid);
		assert.equal(me!.uid, process.getuid());
		assert.ok(me!.startSec > 1_600_000_000 && me!.startSec <= Date.now() / 1000 + 5);
		assert.ok(me!.comm.length > 0);
	});

	itMac("reads cumulative rusage that advances in real seconds", () => {
		const table = new MacOSTable();
		const before = table.rusage(process.pid);
		assert.ok(before);
		// Burn this process's own CPU for ~150 ms, then read again.
		const end = Date.now() + 150;
		let x = 0;
		while (Date.now() < end) x += 1;
		if (x < 0) throw new Error("unreachable");
		const after = table.rusage(process.pid);
		assert.ok(after);
		// The tick conversion must produce real seconds, not mach ticks divided
		// by 1e9 (a 150 ms burn at the wrong scale reads as 3.6 ms).
		assert.ok(after!.own - before!.own >= 0.05);
	});

	itMac("sees a child's CPU folded into the parent after reaping", async () => {
		const table = new MacOSTable();
		const before = table.rusage(process.pid);
		assert.ok(before);
		await new Promise<void>((resolve) => {
			// A child that burns CPU and exits; this process reaps it.
			const child = spawn("/usr/bin/yes", [], { stdio: "ignore" });
			setTimeout(() => {
				child.kill("SIGKILL");
				child.on("exit", () => resolve());
			}, 120);
		});
		const after = table.rusage(process.pid);
		assert.ok(after);
		// A child that burned CPU for 120 ms must add to the parent's reaped
		// time. `>=` would also pass when the reaped accounting is broken.
		assert.ok(after!.reaped - before!.reaped > 0.01, `reaped grew by ${after!.reaped - before!.reaped}s`);
	});

	itMac("reads a tag it planted in a child's environment", async () => {
		const table = new MacOSTable();
		// A system binary would hide its env (SIP); node shows it.
		const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
			env: { ...process.env, CPU_SAMPLE_SESSION: "test:planted-tag" },
			stdio: "ignore",
		});
		try {
			await new Promise((r) => setTimeout(r, 300));
			const tags = table.readEnvTags([child.pid!]);
			assert.equal(tags.get(child.pid!), "test:planted-tag");
		} finally {
			// Whatever the assertion decided, the child must not outlive the test.
			child.kill("SIGKILL");
		}
	});

	itMac("reads a tag whose value contains a newline followed by digits", async () => {
		const table = new MacOSTable();
		// ps escapes a newline in an env value as \012, and a value that starts
		// a line with digits could read as a pid record if the parser trusted
		// any leading digits. A second child carries a different tag, so a mix-up
		// shows as the wrong value rather than as a missing one.
		const mk = (tag: string) =>
			spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], {
				env: { ...process.env, NOTE: "line one\n12345 looks like a pid\nline three", CPU_SAMPLE_SESSION: tag },
				stdio: "ignore",
			});
		const first = mk("test:first");
		const second = mk("test:second");
		try {
			await new Promise((r) => setTimeout(r, 300));
			const tags = table.readEnvTags([first.pid!, second.pid!]);
			assert.equal(tags.get(first.pid!), "test:first");
			assert.equal(tags.get(second.pid!), "test:second");
		} finally {
			first.kill("SIGKILL");
			second.kill("SIGKILL");
		}
	});
});
