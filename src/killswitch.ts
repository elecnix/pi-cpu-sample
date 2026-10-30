/**
 * The kill switch. Two independent ways to turn sampling off:
 *
 * - the file `~/.config/cpu-sample/disabled`: every sampler stops sampling at
 *   its next tick and exits (the Claude Code sampler) or idles (the pi timer),
 *   and the Claude Code hook starts nothing;
 * - `CPU_SAMPLE=off` in the environment, honoured when a sampler starts.
 */

import { accessSync, constants } from "node:fs";

export const DISABLE_FILE = "~/.config/cpu-sample/disabled";

export function killSwitchActive(opts: { dir: string; env: Record<string, string | undefined> }): boolean {
	if (opts.env.CPU_SAMPLE === "off") return true;
	try {
		accessSync(`${opts.dir}/disabled`, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

/** The disabled-file directory with the home directory expanded. */
export function disableDir(home: string): string {
	return `${home}/.config/cpu-sample`;
}
