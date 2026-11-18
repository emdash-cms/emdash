import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

const CHILDREN_KEY = Symbol.for("emdash.workerd-children");
const childrenGlobal = globalThis as typeof globalThis & {
	[CHILDREN_KEY]?: {
		children: Set<ChildProcess>;
		watchdogs: Map<ChildProcess, ChildProcess>;
		onExit: () => void;
	};
};
const state = (childrenGlobal[CHILDREN_KEY] ??= {
	children: new Set<ChildProcess>(),
	watchdogs: new Map<ChildProcess, ChildProcess>(),
	onExit: killWorkerdChildren,
});
const children = state.children;
const watchdogs = state.watchdogs;

export function killWorkerdChildren(): void {
	for (const child of children) signalWorkerd(child, "SIGKILL");
}

function unrefProcess(child: ChildProcess): void {
	child.unref();
	for (const stream of child.stdio) {
		if (stream && "unref" in stream && typeof stream.unref === "function") stream.unref();
	}
}

export function unrefWorkerd(child: ChildProcess): void {
	unrefProcess(child);
	const watchdog = watchdogs.get(child);
	if (watchdog) unrefProcess(watchdog);
}

/** Signal the whole POSIX process group, including any binary launcher. */
export function signalWorkerd(child: ChildProcess, signal: NodeJS.Signals): void {
	if (child.exitCode != null || child.signalCode != null) return;
	if (process.platform === "win32" || !children.has(child) || child.pid === undefined) {
		child.kill(signal);
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch {
		// A group may have disappeared or contain only unreaped zombies.
	}
}

// Do not exec the binary until the host has spawned its sibling watchdog.
// If the host dies before that handshake, EOF makes this launcher exit too.
const START_GATE = `
read -r ready <&4 || exit 1
exec "$@" 4<&-
`;

// The watchdog is the host's own child, so Node reaps it even when Node is
// PID 1. A stop message disarms it after workerd exits; bare EOF means the
// host died while the process group may still be running.
const WATCHDOG = `
while read -r line; do
	[ "$line" = "stop" ] && exit 0
done
kill -KILL -"$1"
`;

export function supportsWorkerdWatchdog(): boolean {
	return process.platform !== "win32" && existsSync("/bin/sh");
}

function removeExitHandlerIfIdle(): void {
	if (children.size === 0 && watchdogs.size === 0) process.off("exit", state.onExit);
}

export function spawnWorkerd(binary: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
	const supervised = supportsWorkerdWatchdog();
	const child = supervised
		? spawn("/bin/sh", ["-c", START_GATE, "emdash-workerd", binary, ...args], {
				detached: true,
				stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
				env,
			})
		: spawn(binary, args, {
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe", "pipe"],
				env,
			});
	if (children.size === 0 && watchdogs.size === 0) process.on("exit", state.onExit);
	children.add(child);

	const gate = child.stdio[4];
	gate?.on("error", () => {});

	function releaseWatchdog(): void {
		if (gate && "destroy" in gate) gate.destroy();
		const lifetime = watchdogs.get(child)?.stdin;
		if (lifetime && !lifetime.destroyed && !lifetime.writableEnded) lifetime.end("stop\n");
	}
	child.once("close", () => {
		releaseWatchdog();
		children.delete(child);
		removeExitHandlerIfIdle();
	});
	// 'close' can wait for launcher descendants holding inherited output pipes.
	child.once("exit", releaseWatchdog);

	if (supervised && child.pid !== undefined) {
		let watchdog: ChildProcess;
		try {
			watchdog = spawn("/bin/sh", ["-c", WATCHDOG, "emdash-workerd-watchdog", String(child.pid)], {
				detached: true,
				stdio: ["pipe", "ignore", "ignore"],
				env,
			});
		} catch (error) {
			signalWorkerd(child, "SIGKILL");
			releaseWatchdog();
			throw error;
		}
		watchdogs.set(child, watchdog);
		watchdog.stdin?.on("error", () => {});
		watchdog.once("spawn", () => {
			if (gate && "end" in gate) gate.end("ready\n");
		});
		watchdog.once("error", () => {
			signalWorkerd(child, "SIGKILL");
			watchdogs.delete(child);
			watchdog.stdin?.destroy();
			removeExitHandlerIfIdle();
		});
		watchdog.once("exit", () => {
			if (children.has(child)) signalWorkerd(child, "SIGKILL");
		});
		watchdog.once("close", () => {
			watchdogs.delete(child);
			removeExitHandlerIfIdle();
		});
	}

	return child;
}
