/**
 * The real Linux backend, exercised against the running kernel. Skipped
 * everywhere else, so CI on Linux runs it and the macOS run skips it.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
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

	itLinux("keeps a process apart from a same-second namesake", () => {
		// A pid reused inside the same second must not share a key with its
		// previous holder, so the sub-second part has to reach the key.
		const rows = new LinuxTable().rows()!;
		const row = rows.find((r) => r.startUsec !== 0);
		assert.ok(row, "some start time should carry a sub-second part");
		assert.notEqual(keyOf({ ...row!, startUsec: 0 }), keyOf(row!));
	});
});
