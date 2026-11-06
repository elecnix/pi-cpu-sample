import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	cachePaths,
	keyFor,
	readEntries,
	readEntry,
	readOwnerState,
	readResult,
	removeEntry,
	removeResult,
	writeEntry,
	writeOwnerState,
	writeResult,
	type RegistryEntry,
	type ResultFile,
} from "../src/registry.js";
import type { SampleRecord } from "../src/types.js";

function tempPaths() {
	const root = mkdtempSync(join(tmpdir(), "cpu-sample-registry-"));
	return { root, paths: cachePaths(root) };
}

function entry(key: string, patch: Partial<RegistryEntry> = {}): RegistryEntry {
	return {
		v: 1,
		key,
		session: key.startsWith("pi-") ? `pi:${key.slice(3)}` : `claude:${key}`,
		agent: key.startsWith("pi-") ? "pi" : "claude",
		agentPid: 100,
		clientPid: 100,
		cwd: "/w",
		busy: false,
		beat: 1_700_000_000_000,
		deliveredRun: null,
		deliveredSeq: -1,
		...patch,
	};
}

function sample(run: string, seq: number): SampleRecord {
	return {
		v: 1,
		ts: new Date(1_700_000_000_000 + seq * 30_000).toISOString(),
		run,
		seq,
		agent: "pi",
		session: "pi:s1",
		cwd: "/w",
		agentPid: 100,
		intervalS: seq === 0 ? null : 30,
		agentCpuS: seq,
		descendantCpuS: 0,
		taggedOrphanCpuS: 0,
		procs: [],
		procsTruncated: false,
		docker: { ok: true, stacks: [] },
		dockerVmCpuS: 0,
		dockerVmBoot: null,
		sampleCpuS: 0.001,
		sampleWallS: 0.002,
	};
}

describe("keyFor", () => {
	it("turns a session tag into a filename-safe key", () => {
		assert.equal(keyFor("pi:0f5f2f0e-1b2c-4d5e-8f90-123456789abc"), "pi-0f5f2f0e-1b2c-4d5e-8f90-123456789abc");
		assert.equal(keyFor("claude:abc/def"), "claude-abc-def");
		assert.equal(keyFor("pi:.."), "pi-..");
	});

	it("never leaves a path separator or a colon", () => {
		for (const session of ["pi:a:b", "claude:../x", "pi:a b"]) {
			const key = keyFor(session);
			assert.doesNotMatch(key, /[/:\\ ]/);
		}
	});
});

describe("registry entries", () => {
	it("round-trips one entry and reads it back", () => {
		const { root, paths } = tempPaths();
		try {
			writeEntry(paths, entry("pi-s1"));
			const got = readEntry(paths, "pi-s1");
			assert.deepEqual(got, entry("pi-s1"));
			assert.ok(existsSync(join(paths.registryDir, "pi-s1.json")));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("lists every live entry and ignores malformed or foreign files", () => {
		const { root, paths } = tempPaths();
		try {
			writeEntry(paths, entry("pi-a"));
			writeEntry(paths, entry("claude-b"));
			writeFileSync(join(paths.registryDir, "broken.json"), "{not json");
			writeFileSync(join(paths.registryDir, "foreign.json"), JSON.stringify({ v: 2, session: "pi:x" }));
			writeFileSync(join(paths.registryDir, "notes.txt"), "ignore me");
			const keys = readEntries(paths)
				.map((e) => e.key)
				.sort();
			assert.deepEqual(keys, ["claude-b", "pi-a"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("removes an entry and leaves no temporary file behind", () => {
		const { root, paths } = tempPaths();
		try {
			writeEntry(paths, entry("pi-s1"));
			removeEntry(paths, "pi-s1");
			assert.equal(readEntry(paths, "pi-s1"), null);
			assert.deepEqual(
				readdirSync(paths.registryDir).filter((n) => n.includes(".tmp")),
				[],
			);
			// removing twice is not an error: two clients can race a teardown
			removeEntry(paths, "pi-s1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("result files", () => {
	const result = (seq: number): ResultFile => ({
		v: 1,
		key: "pi-s1",
		session: "pi:s1",
		agent: "pi",
		agentPid: 100,
		clientPid: 100,
		cwd: "/w",
		ownerPid: 200,
		writtenAt: new Date(1_700_000_000_000).toISOString(),
		run: "r1",
		seq,
		final: false,
		record: sample("r1", seq),
		state: {
			run: "r1",
			seq: seq + 1,
			lastTs: 1_700_000_000_000,
			ledger: {
				lastBuckets: { agent: 1, descendant: 2, taggedOrphan: 0 },
				bucketOf: [["100:1:100", "agent"]],
				lastTotal: [["100:1:100", 3]],
				lastParent: [["100:1:100", null]],
			},
			everInTree: ["100:1:100"],
			outsideTree: [],
			dockerSeen: [],
		},
	});

	it("round-trips a result with its state", () => {
		const { root, paths } = tempPaths();
		try {
			writeResult(paths, "pi-s1", result(4));
			assert.deepEqual(readResult(paths, "pi-s1"), result(4));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns null for an absent result", () => {
		const { root, paths } = tempPaths();
		try {
			assert.equal(readResult(paths, "pi-none"), null);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("removes a result and tolerates a second removal", () => {
		const { root, paths } = tempPaths();
		try {
			writeResult(paths, "pi-s1", result(1));
			removeResult(paths, "pi-s1");
			assert.equal(readResult(paths, "pi-s1"), null);
			removeResult(paths, "pi-s1");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("owner state", () => {
	it("round-trips the tag cache and the VM totals", () => {
		const { root, paths } = tempPaths();
		try {
			const state = {
				v: 1 as const,
				pid: 200,
				ts: 1_700_000_000_000,
				tags: [["100:1:100", "pi:s1"], ["101:1:101", null]] as [string, string | null][],
				vmSeen: [["300:1:1", 12.5]] as [string, number][],
				vmBoot: 1_699_999_000,
			};
			writeOwnerState(paths, state);
			assert.deepEqual(readOwnerState(paths), state);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("returns null when no owner ran yet", () => {
		const { root, paths } = tempPaths();
		try {
			assert.equal(readOwnerState(paths), null);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
