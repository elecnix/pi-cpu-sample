/**
 * macOS backend: the kernel process table through `sysctl(KERN_PROC_ALL)`,
 * cumulative rusage through `proc_pid_rusage`, and env tags through
 * `ps -axeww` (the kernel stopped answering KERN_PROCARGS2 on macOS 27).
 *
 * The struct offsets below match kinfo_proc on arm64 and x86_64 macOS. The
 * first read validates them against this process's own row, so an OS change
 * that moves a field disables sampling instead of misattributing CPU.
 */

import { execFileSync } from "node:child_process";
import koffi from "koffi";
import type { ProcCpu, ProcRow, ProcTable } from "./types.js";

// kinfo_proc field offsets, verified empirically on macOS 27.
const OFF_START_SEC = 0; // struct timeval tv_sec (int64)
const OFF_START_USEC = 8; // tv_usec (int32)
const OFF_PID = 40; // extern_proc.p_pid
const OFF_COMM = 243; // extern_proc.p_comm[17]
const OFF_UID = 392; // eproc.e_ucred.cr_uid
const OFF_PPID = 560; // eproc.e_ppid
const KINFO_PROC_SIZE = 648;

const RUSAGE_INFO_V4 = 4;
const RUSAGE_BUF_U64 = 128;

export class MacOSTable implements ProcTable {
	private sysctl: (...args: unknown[]) => number;
	private procPidRusage: (...args: unknown[]) => number;
	private validated = false;

	constructor() {
		const libc = koffi.load("/usr/lib/libc.dylib");
		const libproc = koffi.load("/usr/lib/libproc.dylib");
		this.sysctl = libc.func("sysctl", "int", ["int *", "uint", "void *", "size_t *", "void *", "size_t"]);
		this.procPidRusage = libproc.func("proc_pid_rusage", "int", ["int", "int", "void *"]);
	}

	rows(): ProcRow[] | null {
		const sizeBuf = Buffer.alloc(8);
		const mib = Buffer.alloc(12);
		mib.writeInt32LE(1, 0); // CTL_KERN
		mib.writeInt32LE(14, 4); // KERN_PROC
		mib.writeInt32LE(0, 8); // KERN_PROC_ALL
		let rc = this.sysctl(mib, 3, null, sizeBuf, null, 0);
		if (rc !== 0) return null;
		const size = Number(sizeBuf.readBigUInt64LE(0));
		if (size === 0 || size % KINFO_PROC_SIZE !== 0) return null;
		const buf = Buffer.alloc(size);
		rc = this.sysctl(mib, 3, buf, sizeBuf, null, 0);
		if (rc !== 0) return null;
		const count = size / KINFO_PROC_SIZE;
		const rows: ProcRow[] = [];
		for (let i = 0; i < count; i++) {
			const o = i * KINFO_PROC_SIZE;
			rows.push({
				pid: buf.readInt32LE(o + OFF_PID),
				ppid: buf.readInt32LE(o + OFF_PPID),
				uid: buf.readUInt32LE(o + OFF_UID),
				comm: buf.toString("utf8", o + OFF_COMM, o + OFF_COMM + 17).split("\0")[0] ?? "",
				startSec: Number(buf.readBigInt64LE(o + OFF_START_SEC)),
				startUsec: buf.readInt32LE(o + OFF_START_USEC),
			});
		}
		if (!this.validated) {
			if (!this.validate(rows)) return null;
			this.validated = true;
		}
		return rows;
	}

	private validate(rows: ProcRow[]): boolean {
		const me = rows.find((r) => r.pid === process.pid);
		if (!me) return false;
		if (me.ppid !== process.ppid) return false;
		if (me.uid !== (process.getuid?.() ?? -1)) return false;
		return true;
	}

	rusage(pid: number): ProcCpu | null {
		const buf = Buffer.alloc(RUSAGE_BUF_U64 * 8);
		const rc = this.procPidRusage(pid, RUSAGE_INFO_V4, buf);
		if (rc !== 0) return null;
		const u64 = (i: number) => Number(buf.readBigUInt64LE(i * 8));
		// rusage_info_v4: uuid[2], user(2), system(3), ..., proc_start(10),
		// proc_exit(11), child_user(12), child_system(13).
		return { own: (u64(2) + u64(3)) / 1e9, reaped: (u64(12) + u64(13)) / 1e9 };
	}

	readEnvTags(pids: number[]): Map<number, string | null> {
		const out = new Map<number, string | null>();
		if (pids.length === 0) return out;
		// `ps -axEww` is the only remaining way to read another process's
		// environment on macOS 27: -a selects everything, capital -E displays
		// the environment (lowercase -e only selects), and -p cannot narrow a
		// selection that -a already made. This runs at most once per tick, and
		// only when new candidate processes appeared. Hardened and SIP-protected
		// binaries hide their environment from this; a tag inside such a
		// process is missed, which the README records as a limit.
		let text: string;
		try {
			text = execFileSync("/bin/ps", ["-axEww", "-o", "pid=,command="], {
				timeout: 15_000,
				maxBuffer: 256 * 1024 * 1024,
			}).toString("utf8");
		} catch {
			for (const pid of pids) out.set(pid, null);
			return out;
		}
		const wanted = new Set(pids);
		// Records: a line whose first token is a pid starts one; env values
		// that contain newlines arrive as continuation lines.
		const records = new Map<number, string>();
		let current = -1;
		for (const line of text.split("\n")) {
			const m = /^\s*(\d+)\s?(.*)$/.exec(line);
			if (m) {
				current = Number(m[1]);
				if (wanted.has(current)) records.set(current, m[2] ?? "");
			} else if (current !== -1 && wanted.has(current)) {
				records.set(current, (records.get(current) ?? "") + " " + line);
			}
		}
		for (const pid of pids) {
			const rec = records.get(pid);
			const m = rec ? /(?:^|\s)CPU_SAMPLE_SESSION=([^\s]*)/.exec(rec) : null;
			out.set(pid, m ? (m[1] ?? null) : null);
		}
		return out;
	}
}

export function macosTable(): ProcTable {
	return new MacOSTable();
}
