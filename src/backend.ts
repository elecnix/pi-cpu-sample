/** Platform selection for the process table. */

import { linuxTable } from "./linux.js";
import { macosTable } from "./macos.js";
import type { ProcTable } from "./types.js";

export function createTable(): ProcTable | null {
	if (process.platform === "darwin") return macosTable();
	if (process.platform === "linux") return linuxTable();
	return null;
}
