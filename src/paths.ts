/** Path containment for Docker compose working directories. */

import { posix } from "node:path";

/**
 * True when `child` sits at or under `parent`. Both sides are normalised first,
 * so `/w/../etc` is not under `/w`, and `/w/./sub` is.
 */
export function isUnder(child: string, parent: string): boolean {
	const c = normalise(child);
	const p = normalise(parent);
	if (p === "/") return c.startsWith("/");
	return c === p || c.startsWith(p + "/");
}

function normalise(path: string): string {
	if (path === "") return "/";
	// `normalize` keeps a trailing separator, so drop it to compare one form.
	const normalised = posix.normalize(path).replace(/\/+$/, "");
	return normalised === "" ? "/" : normalised;
}
