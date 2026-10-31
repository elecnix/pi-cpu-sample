/** Path containment for Docker compose working directories. */
export function isUnder(child: string, parent: string): boolean {
	const c = child.replace(/\/+$/, "");
	const p = parent.replace(/\/+$/, "");
	if (p === "") return c === "" || c.startsWith("/");
	return c === p || c.startsWith(p + "/");
}
