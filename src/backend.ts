/** Platform selection for the process table. */

import { linuxTable } from "./linux.js";
import { macosTable } from "./macos.js";
import type { ProcTable } from "./types.js";

/**
 * The table for this platform, or null when there is none. A backend whose
 * libraries or kernel calls fail at construction returns null too, so the
 * extension reports "not sampling" instead of failing to load.
 */
export function createTable(): ProcTable | null {
	try {
		if (process.platform === "darwin") return macosTable();
		if (process.platform === "linux") return linuxTable();
	} catch {
		return null;
	}
	return null;
}
