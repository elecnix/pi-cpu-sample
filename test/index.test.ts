import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import extension from "../src/index.js";
import { disableDir, killSwitchActive } from "../src/killswitch.js";
import { cachePaths, readEntries, readResult } from "../src/registry.js";
import type { ExtensionAPI, ExtensionContext } from "../src/pi-stubs.js";

/** Enough of the pi host to drive the extension. */
class FakePi {
	entries: { customType: string; data: unknown }[] = [];
	private handlers = new Map<string, Array<(event: unknown, ctx?: ExtensionContext) => unknown>>();

	api(): ExtensionAPI {
		return {
			on: (event: string, handler: (event: unknown, ctx?: ExtensionContext) => unknown) => {
				const list = this.handlers.get(event) ?? [];
				list.push(handler);
				this.handlers.set(event, list);
			},
			appendEntry: (customType: string, data?: unknown) => {
				this.entries.push({ customType, data });
			},
		} as unknown as ExtensionAPI;
	}

	async emit(event: string, ctx?: ExtensionContext): Promise<void> {
		for (const handler of this.handlers.get(event) ?? []) await handler({ type: event }, ctx);
	}
}

function fakeContext(sessionId: string): ExtensionContext {
	return {
		cwd: process.cwd(),
		isIdle: () => false,
		sessionManager: { getSessionId: () => sessionId },
	};
}

const skipped = killSwitchActive({ dir: disableDir(homedir()), env: process.env });

/** Wait until the extension's background tick has landed, or give up. */
async function until(check: () => boolean, timeoutMs = 10_000): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
}

describe("the pi extension over a shared cache", { skip: skipped }, () => {
	it("records a sample into the transcript and cleans up at shutdown", async () => {
		const root = mkdtempSync(join(tmpdir(), "cpu-sample-index-"));
		const previous = process.env.CPU_SAMPLE_CACHE_DIR;
		const previousSession = process.env.CPU_SAMPLE_SESSION;
		process.env.CPU_SAMPLE_CACHE_DIR = root;
		try {
			const pi = new FakePi();
			extension(pi.api());
			const ctx = fakeContext(`test-${process.pid}`);
			await pi.emit("session_start", ctx);
			// session_start ticks at once: the record is the session's baseline.
			await until(() => pi.entries.length >= 1);
			assert.equal(pi.entries.length, 1);
			assert.equal(pi.entries[0]?.customType, "cpu-sample");
			const record = pi.entries[0]?.data as { session: string; seq: number };
			assert.equal(record.session, `pi:test-${process.pid}`);
			assert.equal(record.seq, 0);
			assert.equal(process.env.CPU_SAMPLE_SESSION, `pi:test-${process.pid}`);

			// The registration names this process as both client and agent.
			const cache = cachePaths(root);
			assert.equal(readEntries(cache)[0]?.clientPid, process.pid);

			await pi.emit("session_shutdown", ctx);
			// The teardown record closes the interval.
			assert.equal(pi.entries.length, 2);
			assert.equal((pi.entries[1]?.data as { seq: number }).seq, 1);
			// The session's files are gone and nothing else was left behind.
			assert.deepEqual(readEntries(cache), []);
			assert.equal(readResult(cache, `pi-test-${process.pid}`), null);
			assert.equal(process.env.CPU_SAMPLE_SESSION, undefined);
		} finally {
			if (previous === undefined) delete process.env.CPU_SAMPLE_CACHE_DIR;
			else process.env.CPU_SAMPLE_CACHE_DIR = previous;
			if (previousSession === undefined) delete process.env.CPU_SAMPLE_SESSION;
			else process.env.CPU_SAMPLE_SESSION = previousSession;
			rmSync(root, { recursive: true, force: true });
		}
	});
});
