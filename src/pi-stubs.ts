/**
 * Local type stubs for the Pi host package.
 *
 * `@earendil-works/pi-coding-agent` is an optional peer dependency that is not
 * installed in CI. These stubs describe just enough of its surface for this
 * extension to compile and type-check. At runtime inside Pi, the real
 * implementation is used.
 */

export interface ExtensionContext {
	cwd: string;
	/** Whether the session has no active agent run or compaction. */
	isIdle(): boolean;
	sessionManager: {
		getSessionId(): string;
	};
}

export interface SessionStartEvent {
	type: "session_start";
	reason: "startup" | "reload" | "new" | "resume" | "fork";
}

export interface SessionShutdownEvent {
	type: "session_shutdown";
	reason: "quit" | "reload" | "new" | "resume" | "fork";
}

export interface AgentStartEvent {
	type: "agent_start";
}

/** Fired after a run has fully settled: no retry, compaction, or queued turn follows. */
export interface AgentSettledEvent {
	type: "agent_settled";
	aborted: boolean;
}

export interface ExtensionAPI {
	on(event: "session_start", handler: (event: SessionStartEvent, ctx: ExtensionContext) => void | Promise<void>): void;
	on(
		event: "session_shutdown",
		handler: (event: SessionShutdownEvent, ctx: ExtensionContext) => void | Promise<void>,
	): void;
	on(event: "agent_start", handler: (event: AgentStartEvent, ctx: ExtensionContext) => void | Promise<void>): void;
	on(event: "agent_settled", handler: (event: AgentSettledEvent, ctx: ExtensionContext) => void | Promise<void>): void;
	appendEntry<T = unknown>(customType: string, data?: T): void;
}
