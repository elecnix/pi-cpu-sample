/**
 * Linux backend: /proc. Same accounting rules as the macOS backend, so a
 * session sampled on Linux reads the same in the report.
 */

import { readFileSync, readdirSync } from "node:fs";
import type { ProcCpu, ProcRow, ProcTable } from "./types.js";

const CLK_TCK = 100;

export class LinuxTable implements ProcTable {
	rows(): ProcRow[] | null {
		let names: string[];
		try {
			names = readdirSync("/proc");
		} catch {
			return null;
		}
		const rows: ProcRow[] = [];
		for (const name of names) {
			const pid = Number(name);
			if (!Number.isInteger(pid) || pid <= 0) continue;
			try {
				const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
				// comm sits between the first '(' and the last ')' and may hold spaces.
				const open = stat.indexOf("(");
				const close = stat.lastIndexOf(")");
				if (open < 0 || close < open) continue;
				const comm = stat.slice(open + 1, close);
				const rest = stat.slice(close + 2).split(" ");
				// rest[0] is state; kernel fields from here are 1-based field 3 onward.
				const ppid = Number(rest[1]);
				const utime = Number(rest[11]);
				const starttime = Number(rest[19]);
				const status = readFileSync(`/proc/${pid}/status`, "utf8");
				const uidLine = /^Uid:\s+(\d+)/m.exec(status);
				rows.push({
					pid,
					ppid,
					uid: uidLine ? Number(uidLine[1]) : -1,
					comm,
					startSec: Math.floor((starttime / CLK_TCK) + bootSeconds()),
					startUsec: 0,
				});
			} catch {
				// The process vanished between readdir and read: skip it.
			}
		}
		return rows;
	}

	rusage(pid: number): ProcCpu | null {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const close = stat.lastIndexOf(")");
			const rest = stat.slice(close + 2).split(" ");
			const utime = Number(rest[11]);
			const stime = Number(rest[12]);
			const cutime = Number(rest[13]);
			const cstime = Number(rest[14]);
			return { own: (utime + stime) / CLK_TCK, reaped: (cutime + cstime) / CLK_TCK };
		} catch {
			return null;
		}
	}

	readEnvTags(pids: number[]): Map<number, string | null> {
		const out = new Map<number, string | null>();
		for (const pid of pids) {
			try {
				const env = readFileSync(`/proc/${pid}/environ`, "utf8");
				const m = /(?:^|\0)CPU_SAMPLE_SESSION=([^\0]*)/.exec(env);
				out.set(pid, m ? (m[1] || null) : null);
			} catch {
				out.set(pid, null);
			}
		}
		return out;
	}
}

let bootSecs: number | null = null;
function bootSeconds(): number {
	bootSecs ??= Date.now() / 1000 - Number(readFileSync("/proc/uptime", "utf8").split(" ")[0]);
	return bootSecs;
}

export function linuxTable(): ProcTable {
	return new LinuxTable();
}
