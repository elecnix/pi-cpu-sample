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
	private sysctlbyname: (...args: unknown[]) => number;
	private procPidRusage: (...args: unknown[]) => number;
	private procListChildPids: (...args: unknown[]) => number;
	private validated = false;
	private tickHz: number | null = null;
	private bootSec: number | null = null;

	constructor() {
		const libc = koffi.load("/usr/lib/libc.dylib");
		const libproc = koffi.load("/usr/lib/libproc.dylib");
		this.sysctl = libc.func("sysctl", "int", ["int *", "uint", "void *", "size_t *", "void *", "size_t"]);
		this.sysctlbyname = libc.func("sysctlbyname", "int", ["string", "void *", "size_t *", "void *", "size_t"]);
		this.procPidRusage = libproc.func("proc_pid_rusage", "int", ["int", "int", "void *"]);
		this.procListChildPids = libproc.func("proc_listchildpids", "int", ["int", "void *", "int"]);
	}

	/** Mach tick frequency (24 MHz on Apple Silicon, 1 GHz on Intel). */
	private ticksPerSecond(): number {
		if (this.tickHz === null) {
			const buf = Buffer.alloc(8);
			const sizeBuf = Buffer.alloc(8);
			sizeBuf.writeBigUInt64LE(8n);
			const rc = this.sysctlbyname("hw.tbfrequency", buf, sizeBuf, null, 0);
			this.tickHz = rc === 0 ? Number(buf.readBigUInt64LE(0)) : 1e9;
		}
		return this.tickHz;
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
		// rusage_info_v4: uuid[0..1], user(2), system(3), ..., pageins(8),
		// wasted(9), proc_start(10), proc_exit(11), child_user(12),
		// child_system(13). The times are mach ticks, not nanoseconds: divide by
		// hw.tbfrequency.
		const hz = this.ticksPerSecond();
		return { own: (u64(2) + u64(3)) / hz, reaped: (u64(12) + u64(13)) / hz };
	}

	childPids(pid: number): number[] | null {
		for (let capacity = 64; capacity <= 4096; capacity *= 2) {
			const buf = Buffer.alloc(capacity * 4);
			const n = Number(this.procListChildPids(pid, buf, buf.length));
			if (n < 0) return null;
			if (n < capacity) {
				const pids: number[] = [];
				for (let i = 0; i < n; i++) pids.push(buf.readInt32LE(i * 4));
				return pids;
			}
		}
		return null;
	}

	/**
	 * One live pid's row, through `proc_pid_rusage` alone: macOS 27 no longer
	 * answers a per-pid process table lookup, and scanning the whole table for
	 * one pid would cost more than the sample it is meant to save.
	 *
	 * The row exists exactly while the process is alive: a reaped process
	 * reports an exit time. macOS 27 fills neither the pid field nor the
	 * microsecond start, and its `proc_start_abstime` runs on a clock that stops
	 * in sleep, so `startSec` here is for display only and the caller must not
	 * compare it against the table's.
	 */
	row(pid: number): ProcRow | null {
		const buf = Buffer.alloc(RUSAGE_BUF_U64 * 8);
		if (this.procPidRusage(pid, RUSAGE_INFO_V4, buf) !== 0) return null;
		const u64 = (i: number) => buf.readBigUInt64LE(i * 8);
		if (u64(11) !== 0n) return null; // proc_exit_abstime: the process is gone
		const startTicks = u64(10); // proc_start_abstime
		if (startTicks === 0n) return null;
		const startSec = Math.floor(this.bootSeconds() + Number(startTicks) / this.ticksPerSecond());
		return { pid, ppid: -1, uid: -1, comm: "", startSec, startUsec: 0 };
	}

	/** Wall-clock seconds at boot, from `kern.boottime`. */
	private bootSeconds(): number {
		if (this.bootSec === null) {
			const buf = Buffer.alloc(16);
			const sizeBuf = Buffer.alloc(8);
			sizeBuf.writeBigUInt64LE(16n);
			const rc = this.sysctlbyname("kern.boottime", buf, sizeBuf, null, 0);
			this.bootSec = rc === 0 ? Number(buf.readBigInt64LE(0)) : 0;
		}
		return this.bootSec;
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
		return parseEnvRecords(text, pids);
	}
}

/**
 * Extract each pid's CPU_SAMPLE_SESSION value from `ps -axEww -o pid=,command=`
 * output.
 *
 * Every process is exactly one line: the pid column is five characters wide
 * followed by one space, and ps escapes a newline inside an env value as the
 * four characters `\012`, so nothing a process holds can start a line that
 * looks like a record. A line that does not carry the pid column is skipped
 * rather than joined to the record above it, because joining is what would let
 * a stray line be read as another pid's record.
 */
export function parseEnvRecords(text: string, pids: number[]): Map<number, string | null> {
	const out = new Map<number, string | null>();
	const wanted = new Set(pids);
	const records = new Map<number, string>();
	for (const line of text.split("\n")) {
		const m = /^ *(\d+) (.+)$/.exec(line);
		if (!m) continue;
		const pid = Number(m[1]);
		if (wanted.has(pid)) records.set(pid, m[2] ?? "");
	}
	for (const pid of pids) {
		const rec = records.get(pid);
		const m = rec ? /(?:^| )CPU_SAMPLE_SESSION=(\S*)/.exec(rec) : null;
		out.set(pid, m ? (m[1] ?? null) : null);
	}
	return out;
}

export function macosTable(): ProcTable {
	return new MacOSTable();
}
