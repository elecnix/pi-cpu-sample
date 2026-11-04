/**
 * Linux backend: /proc. Same accounting rules as the macOS backend, so a
 * session sampled on Linux reads the same in the report.
 */

import { readFileSync, readdirSync } from "node:fs";
import type { ProcCpu, ProcRow, ProcTable } from "./types.js";

const CLK_TCK = 100;

/**
 * A start time as whole seconds plus microseconds. `/proc` gives the start in
 * clock ticks, so the sub-second part is a hundredth of a second; carrying it
 * keeps the process key distinct when a pid is reused within a second.
 */
function startTime(ticks: number): { startSec: number; startUsec: number } {
	const absolute = ticks / CLK_TCK + bootSeconds();
	let startSec = Math.floor(absolute);
	let startUsec = Math.round((absolute - startSec) * 1e6);
	if (startUsec >= 1_000_000) {
		startSec += 1;
		startUsec = 0;
	}
	return { startSec, startUsec };
}

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
					...startTime(starttime),
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

	childPids(pid: number): number[] | null {
		// Each task (thread) has its own children file, so a child forked by a
		// worker thread is only listed under that thread. Union every thread's
		// list. /proc/<pid>/children answers the same question where a kernel
		// build provides it, so it is the fallback.
		const tasks = `/proc/${pid}/task`;
		let tids: string[];
		try {
			tids = readdirSync(tasks);
		} catch {
			return null;
		}
		const pids = new Set<number>();
		let read = 0;
		for (const tid of tids) {
			try {
				const text = readFileSync(`${tasks}/${tid}/children`, "utf8").trim();
				read += 1;
				if (text === "") continue;
				for (const part of text.split(/\s+/)) {
					const child = Number(part);
					if (Number.isInteger(child) && child > 0) pids.add(child);
				}
			} catch {
				// A thread that vanished between the listing and the read, or a
				// kernel without CONFIG_PROC_CHILDREN.
			}
		}
		if (read === tids.length) return [...pids];
		try {
			const text = readFileSync(`/proc/${pid}/children`, "utf8").trim();
			return text === "" ? [] : text.split(/\s+/).map(Number).filter((n) => Number.isInteger(n) && n > 0);
		} catch {
			return null;
		}
	}

	row(pid: number): ProcRow | null {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const open = stat.indexOf("(");
			const close = stat.lastIndexOf(")");
			if (open < 0 || close < open) return null;
			const rest = stat.slice(close + 2).split(" ");
			const starttime = Number(rest[19]);
			if (!Number.isInteger(starttime)) return null;
			return {
				pid,
				ppid: Number(rest[1]),
				uid: -1,
				comm: stat.slice(open + 1, close),
				...startTime(starttime),
			};
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
