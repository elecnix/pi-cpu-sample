import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerClient } from "../src/docker.js";

/** Minimal HTTP/1.1 server on a unix socket, enough for the two Engine API routes. */
function startDockerMock(handlers: { containers: unknown; stats: Record<string, number> }): {
	socketPath: string;
	close: () => Promise<void>;
} {
	const dir = mkdtempSync(join(tmpdir(), "docker-mock-"));
	const socketPath = join(dir, "docker.sock");
	const server: Server = createServer((socket: Socket) => {
		let pending = "";
		socket.on("data", (chunk: Buffer) => {
			pending += chunk.toString("utf8");
			let end: number;
			while ((end = pending.indexOf("\r\n\r\n")) !== -1) {
				const head = pending.slice(0, end);
				pending = pending.slice(end + 4);
				const path = /^GET (\S+) HTTP/.exec(head)?.[1] ?? "/";
				const body = path.startsWith("/containers/json")
					? JSON.stringify(handlers.containers)
					: (() => {
							const id = /\/containers\/([^/]+)\/stats/.exec(path)?.[1] ?? "";
							return JSON.stringify({ cpu_stats: { cpu_usage: { total_usage: handlers.stats[id] ?? 0 } } });
						})();
				const payload = Buffer.from(body, "utf8");
				socket.write(
					`HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: ${payload.length}\r\n\r\n`,
				);
				socket.write(payload);
			}
		});
	});
	server.listen(socketPath);
	return {
		socketPath,
		close: () =>
			new Promise((resolve) => {
				server.close(() => resolve());
				rmSync(dir, { recursive: true, force: true });
			}),
	};
}

describe("DockerClient", () => {
	const cleanups: Array<() => Promise<void>> = [];
	after(async () => {
		for (const fn of cleanups) await fn();
	});

	it("reports containers of stacks under the session cwd", async () => {
		const mock = startDockerMock({
			containers: [
				{ Id: "aaa111", Labels: { "com.docker.compose.project": "web", "com.docker.compose.project.working_dir": "/w/deploy/local" } },
				{ Id: "bbb222", Labels: { "com.docker.compose.project": "other", "com.docker.compose.project.working_dir": "/elsewhere" } },
				{ Id: "ccc333", Labels: {} },
			],
			stats: { aaa111: 223_662_229_000, bbb222: 1, ccc333: 5 },
		});
		cleanups.push(mock.close);
		const client = new DockerClient(mock.socketPath);
		const snap = await client.listUnder("/w");
		assert.equal(snap.ok, true);
		assert.equal(snap.containers.length, 1);
		assert.equal(snap.containers[0]?.id, "aaa111");
		assert.equal(snap.containers[0]?.project, "web");
		assert.equal(snap.containers[0]?.dir, "/w/deploy/local");
		assert.equal(snap.containers[0]?.cpuS, 223.662229);
	});

	it("marks the snapshot failed when the socket is missing", async () => {
		const client = new DockerClient(join(tmpdir(), "no-such-docker-sock"));
		const snap = await client.listUnder("/w");
		assert.equal(snap.ok, false);
		assert.equal(snap.containers.length, 0);
	});
});
