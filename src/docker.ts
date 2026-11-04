/**
 * Docker Engine API client over the local unix socket.
 *
 * Reads each running container's cumulative CPU counter (one-shot stats) and
 * the compose labels that map it to a stack. Docker missing or stopped is not
 * an error for the sampler: the snapshot comes back marked not ok.
 */

import { existsSync } from "node:fs";
import { request, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { isUnder } from "./paths.js";
import type { ContainerObs } from "./ledger.js";

/** Docker Desktop's socket, then the classic Engine socket. */
export function defaultSockets(home: string = homedir()): string[] {
	return [`${home}/.docker/run/docker.sock`, "/var/run/docker.sock"];
}

/**
 * The socket to connect to: `DOCKER_HOST` when it names a unix socket, else the
 * first default location that exists, else the first default location, so a
 * missing socket reads as Docker being down. A tcp endpoint is not supported
 * and resolves to null.
 */
export function resolveSocket(opts: {
	DOCKER_HOST?: string | undefined;
	exists?: (path: string) => boolean;
	home?: string;
}): string | null {
	const exists = opts.exists ?? existsSync;
	const defaults = defaultSockets(opts.home);
	const host = opts.DOCKER_HOST?.trim();
	if (host) {
		if (!host.startsWith("unix://")) return null;
		const path = host.slice("unix://".length);
		return exists(path) ? path : null;
	}
	return defaults.find((p) => exists(p)) ?? null;
}

interface ContainerListEntry {
	Id?: string;
	Labels?: Record<string, string>;
}

export const LABEL_DIR = "com.docker.compose.project.working_dir";
export const LABEL_PROJECT = "com.docker.compose.project";

export class DockerClient {
	private readonly explicitPath: string | undefined;

	/**
	 * Pass a socket path to override the resolution, or none to resolve on each
	 * call. Resolving per call is what lets a session pick up a Docker that
	 * starts after the session did.
	 */
	constructor(
		socketPath?: string,
		private timeoutMs = 4000,
		private env: Record<string, string | undefined> = process.env,
	) {
		this.explicitPath = socketPath;
	}

	private socket(): string | null {
		if (this.explicitPath !== undefined) return this.explicitPath;
		return resolveSocket({ DOCKER_HOST: this.env.DOCKER_HOST });
	}

	/** Cumulative container CPU seconds for every stack under `cwd`. */
	async listUnder(cwd: string): Promise<{ ok: boolean; containers: ContainerObs[] }> {
		const socketPath = this.socket();
		if (socketPath === null) return { ok: false, containers: [] };
		let list: ContainerListEntry[];
		try {
			const parsed: unknown = JSON.parse(await this.get(socketPath, "/containers/json?all=false"));
			// A 200 with something other than an array is Docker answering badly,
			// not a reason to throw past this method's contract.
			if (!Array.isArray(parsed)) return { ok: false, containers: [] };
			list = parsed as ContainerListEntry[];
		} catch {
			return { ok: false, containers: [] };
		}
		const obs: ContainerObs[] = [];
		for (const c of list) {
			const id = c?.Id ?? "";
			const labels = c?.Labels ?? {};
			const dir = labels[LABEL_DIR] ?? "";
			if (!id || !dir || !isUnder(dir, cwd)) continue;
			try {
				const stats = JSON.parse(
					await this.get(socketPath, `/containers/${id}/stats?stream=false&one-shot=true`),
				) as { cpu_stats?: { cpu_usage?: { total_usage?: number } } };
				const ns = stats.cpu_stats?.cpu_usage?.total_usage;
				if (typeof ns !== "number") continue;
				obs.push({
					id,
					project: labels[LABEL_PROJECT] ?? "",
					dir,
					cpuS: ns / 1e9,
				});
			} catch {
				// A container that will not answer costs nothing to skip.
			}
		}
		return { ok: true, containers: obs };
	}

	private get(socketPath: string, path: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const req = request(
				{
					socketPath,
					path,
					method: "GET",
					timeout: this.timeoutMs,
					headers: { Host: "docker" },
				},
				(res: IncomingMessage) => {
					// Every reply gets an error listener first: a reset while the
					// body drains must reject into the caller's skip path, and the
					// non-200 branch below drains the body too.
					res.on("error", reject);
					if (res.statusCode !== 200) {
						res.resume();
						reject(new Error(`docker api status ${res.statusCode}`));
						return;
					}
					let body = "";
					res.setEncoding("utf8");
					res.on("data", (chunk: string) => {
						body += chunk;
					});
					res.on("end", () => resolve(body));
				},
			);
			req.on("timeout", () => {
				req.destroy(new Error("docker api timeout"));
			});
			req.on("error", reject);
			req.end();
		});
	}
}
