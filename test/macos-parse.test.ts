import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseEnvRecords } from "../src/macos.js";

/** One `ps -axEww -o pid=,command=` record: a 5-wide pid column and a space. */
function record(pid: number, command: string): string {
	return `${String(pid).padStart(5)} ${command}`;
}

describe("parseEnvRecords", () => {
	it("reads one record per pid", () => {
		const text = [record(10, "node app FOO=1"), record(20, "node job CPU_SAMPLE_SESSION=pi:s1")].join("\n");
		const out = parseEnvRecords(text, [10, 20]);
		assert.equal(out.get(10), null);
		assert.equal(out.get(20), "pi:s1");
	});

	it("does not read an env value that starts a line with digits as a new record", () => {
		// ps escapes the newline as \012, so the value is one line; a parser that
		// split on "digits, then anything" would take "12345 looks like a pid"
		// for pid 12345's record and lose the real owner's tag.
		const text = [
			record(10, "node app NOTE=first\\01212345 looks like a pid\\012last CPU_SAMPLE_SESSION=pi:keep"),
			record(12345, "node other CPU_SAMPLE_SESSION=pi:stolen"),
		].join("\n");
		const out = parseEnvRecords(text, [10, 12345]);
		assert.equal(out.get(10), "pi:keep");
		assert.equal(out.get(12345), "pi:stolen");
	});

	it("skips a line that is not a record without joining it to the previous pid", () => {
		// The stray line has no pid column, so only the skip branch can drop it.
		// It carries a tag, so a parser that joined it onto pid 10's record
		// would report that tag for pid 10 and fail here.
		const text = [record(10, "node app FOO=1"), "continuation CPU_SAMPLE_SESSION=pi:stray", record(20, "x")].join("\n");
		const out = parseEnvRecords(text, [10, 20]);
		assert.equal(out.get(10), null);
		assert.equal(out.get(20), null);
	});

	it("returns null for a wanted pid with no record", () => {
		const out = parseEnvRecords(record(10, "node app CPX_SAMPLE=1"), [99]);
		assert.equal(out.get(99), null);
	});
});
