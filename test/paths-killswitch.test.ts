import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { isUnder } from "../src/paths.js";
import { killSwitchActive } from "../src/killswitch.js";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("isUnder", () => {
	it("accepts the directory itself", () => {
		assert.ok(isUnder("/a/b", "/a/b"));
	});

	it("accepts a child directory on the path boundary", () => {
		assert.ok(isUnder("/a/b/deploy/local", "/a/b"));
	});

	it("rejects a sibling that shares a prefix", () => {
		assert.ok(!isUnder("/a/bc", "/a/b"));
	});

	it("rejects a parent", () => {
		assert.ok(!isUnder("/a", "/a/b"));
	});

	it("ignores trailing slashes", () => {
		assert.ok(isUnder("/a/b/", "/a/b/"));
		assert.ok(isUnder("/a/b", "/a/b/"));
	});

	it("resolves . and .. before the prefix test", () => {
		assert.ok(!isUnder("/a/b/../etc", "/a/b"));
		assert.ok(isUnder("/a/b/./sub", "/a/b"));
		assert.ok(isUnder("/a//b/sub", "/a/b"));
		assert.ok(isUnder("/a/b/../b/sub", "/a/b"));
	});

	it("accepts the root under the root", () => {
		assert.ok(isUnder("/", "/"));
	});

	it("treats an unreadable directory as inactive", () => {
		assert.equal(killSwitchActive({ dir: "/nonexistent-dir-that-cannot-exist", env: {} }), false);
	});
});

describe("killSwitchActive", () => {
	it("is on when the disabled file exists", () => {
		const dir = mkdtempSync(join(tmpdir(), "killswitch-"));
		try {
			assert.equal(killSwitchActive({ dir, env: {} }), false);
			writeFileSync(join(dir, "disabled"), "");
			assert.equal(killSwitchActive({ dir, env: {} }), true);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("is on when CPU_SAMPLE is off", () => {
		assert.equal(killSwitchActive({ dir: "/nonexistent", env: { CPU_SAMPLE: "off" } }), true);
		assert.equal(killSwitchActive({ dir: "/nonexistent", env: { CPU_SAMPLE: "on" } }), false);
	});

	it("treats an unreadable directory as inactive", () => {
		assert.equal(killSwitchActive({ dir: "/nonexistent-dir-that-cannot-exist", env: {} }), false);
	});
});
