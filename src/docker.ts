/**
 * Docker Engine API client over the local unix socket.
 *
 * Reads each running container's cumulative CPU counter (one-shot stats) and
 * the compose labels that map it to a stack. Docker missing or stopped is not
 * an error for the sampler: the snapshot comes back marked not ok.
 */

import { request, type IncomingMessage } from "node:http";
import { homedir } from "node:os";
import { isUnder } from "./paths.js";
import type { ContainerObs } from "./ledger.js";

export const DEFAULT_SOCKET = `${homedir()}/.docker/run/docker.sock`;

interface ContainerListEntry {
	Id?: string;
	Labels?: Record<string, string>;
}

export const LABEL_DIR = "com.docker.compose.project.working_dir";
export const LABEL_PROJECT = "com.docker.compose.project";

export class DockerClient {
	constructor(
		private socketPath: string = DEFAULT_SOCKET,
		private timeoutMs = 4000,
	) {}

	/** Cumulative container CPU seconds for every stack under `cwd`. */
	async listUnder(cwd: string): Promise<{ ok: boolean; containers: ContainerObs[] }> {
		let list: ContainerListEntry[];
		try {
			list = JSON.parse(await this.get("/containers/json?all=false")) as ContainerListEntry[];
		} catch {
			return { ok: false, containers: [] };
		}
		const obs: ContainerObs[] = [];
		for (const c of list) {
			const id = c.Id ?? "";
			const labels = c.Labels ?? {};
			const dir = labels[LABEL_DIR] ?? "";
			if (!id || !dir || !isUnder(dir, cwd)) continue;
			try {
				const stats = JSON.parse(
					await this.get(`/containers/${id}/stats?stream=false&one-shot=true`),
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

	private get(path: string): Promise<string> {
		return new Promise((resolve, reject) => {
			const req = request(
				{
					socketPath: this.socketPath,
					path,
					method: "GET",
					timeout: this.timeoutMs,
					headers: { Host: "docker" },
				},
				(res: IncomingMessage) => {
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
