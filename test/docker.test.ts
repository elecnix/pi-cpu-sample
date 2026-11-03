import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DockerClient, resolveSocket } from "../src/docker.js";

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

	it("skips a container whose response dies mid-body instead of crashing", async () => {
		const dir = mkdtempSync(join(tmpdir(), "docker-mock-"));
		const socketPath = join(dir, "docker.sock");
		const server = createServer((socket: Socket) => {
			socket.on("data", (chunk: Buffer) => {
				const path = /^GET (\S+) HTTP/.exec(chunk.toString("utf8"))?.[1] ?? "/";
				if (path.startsWith("/containers/json")) {
					const body = JSON.stringify([
						{ Id: "aaa111", Labels: { "com.docker.compose.project": "web", "com.docker.compose.project.working_dir": "/w" } },
					]);
					socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
				} else {
					// A stats reply whose body never completes: the socket closes
					// with a reset in the middle of it.
					socket.write("HTTP/1.1 200 OK\r\nContent-Length: 4096\r\n\r\n{\"cpu_stats\":");
					socket.destroy();
				}
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		cleanups.push(
			() =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					rmSync(dir, { recursive: true, force: true });
				}),
		);
		const client = new DockerClient(socketPath);
		const snap = await client.listUnder("/w");
		assert.equal(snap.ok, true);
		assert.equal(snap.containers.length, 0);
	});

	it("survives a non-200 reply whose error body is cut off", async () => {
		const dir = mkdtempSync(join(tmpdir(), "docker-mock-"));
		const socketPath = join(dir, "docker.sock");
		const server = createServer((socket: Socket) => {
			socket.on("data", () => {
				socket.write("HTTP/1.1 500 Internal Server Error\r\nContent-Length: 4096\r\n\r\n{\"message\":");
				socket.destroy();
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		cleanups.push(
			() =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					rmSync(dir, { recursive: true, force: true });
				}),
		);
		const client = new DockerClient(socketPath);
		const snap = await client.listUnder("/w");
		assert.equal(snap.ok, false);
	});

	it("picks up a Docker that starts after the client was built", async () => {
		const dir = mkdtempSync(join(tmpdir(), "docker-mock-"));
		const socketPath = join(dir, "docker.sock");
		const client = new DockerClient(undefined, 4000, { DOCKER_HOST: `unix://${socketPath}` });
		// No socket yet: the first tick reports Docker down.
		assert.equal((await client.listUnder("/w")).ok, false);

		const server = createServer((socket: Socket) => {
			socket.on("data", () => {
				const body = JSON.stringify([]);
				socket.write(`HTTP/1.1 200 OK\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
			});
		});
		await new Promise<void>((resolve) => server.listen(socketPath, resolve));
		cleanups.push(
			() =>
				new Promise<void>((resolve) => {
					server.close(() => resolve());
					rmSync(dir, { recursive: true, force: true });
				}),
		);
		// The same client finds it on a later tick, without being rebuilt.
		const snap = await client.listUnder("/w");
		assert.equal(snap.ok, true);
	});

	it("marks the snapshot failed when the socket is missing", async () => {
		const client = new DockerClient(join(tmpdir(), "no-such-docker-sock"));
		const snap = await client.listUnder("/w");
		assert.equal(snap.ok, false);
		assert.equal(snap.containers.length, 0);
	});
});

describe("resolveSocket", () => {
	const exists = (paths: string[]) => (p: string) => paths.includes(p);

	it("honours DOCKER_HOST for a unix socket", () => {
		assert.equal(resolveSocket({ DOCKER_HOST: "unix:///run/docker.sock", exists: exists(["/run/docker.sock"]) }), "/run/docker.sock");
	});

	it("prefers DOCKER_HOST over the default location", () => {
		const found = resolveSocket({
			DOCKER_HOST: "unix:///run/user/501/docker.sock",
			exists: exists(["/run/user/501/docker.sock", "/home/u/.docker/run/docker.sock"]),
			home: "/home/u",
		});
		assert.equal(found, "/run/user/501/docker.sock");
	});

	it("falls back to Docker Desktop's socket, then the classic path", () => {
		const home = "/home/u";
		const desktop = "/home/u/.docker/run/docker.sock";
		assert.equal(resolveSocket({ exists: exists([desktop, "/var/run/docker.sock"]), home }), desktop);
		assert.equal(resolveSocket({ exists: exists(["/var/run/docker.sock"]), home }), "/var/run/docker.sock");
	});

	it("reports no socket when nothing exists, and refuses a tcp endpoint", () => {
		assert.equal(resolveSocket({ exists: () => false, home: "/home/u" }), null);
		assert.equal(resolveSocket({ DOCKER_HOST: "tcp://127.0.0.1:2375", exists: () => true, home: "/home/u" }), null);
	});
});
