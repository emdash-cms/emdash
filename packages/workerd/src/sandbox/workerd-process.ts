import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CHILDREN_KEY = Symbol.for("emdash.workerd-children");
const childrenGlobal = globalThis as typeof globalThis & {
	[CHILDREN_KEY]?: {
		children: Set<ChildProcess>;
		watchdogs: Map<ChildProcess, ChildProcess>;
		supervisorDirectory: string | null;
		onExit: () => void;
	};
};
const state = (childrenGlobal[CHILDREN_KEY] ??= {
	children: new Set<ChildProcess>(),
	watchdogs: new Map<ChildProcess, ChildProcess>(),
	supervisorDirectory: null,
	onExit: killWorkerdChildren,
});
const children = state.children;
const watchdogs = state.watchdogs;

export function killWorkerdChildren(): void {
	for (const child of children) signalWorkerd(child, "SIGKILL");
	cleanupSupervisorScript();
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

const SUPERVISOR_SOURCE = `
case "$1" in
	start)
		shift
		read -r ready <&4 || exit 1
		exec "$@" 4<&-
		;;
	watch)
		shift
		while read -r line; do
			[ "$line" = "stop" ] && exit 0
		done
		kill -KILL -"$1"
		;;
	*)
		exit 2
		;;
esac
`;

function cleanupSupervisorScript(): void {
	const directory = state.supervisorDirectory;
	state.supervisorDirectory = null;
	if (!directory) return;
	try {
		rmSync(directory, { recursive: true, force: true });
	} catch {
		// Cleanup must not interrupt process-group termination.
	}
}

function supervisorScript(): string {
	if (state.supervisorDirectory) return join(state.supervisorDirectory, "supervisor.sh");
	const directory = mkdtempSync(join(tmpdir(), "emdash-workerd-supervisor-"));
	state.supervisorDirectory = directory;
	const script = join(directory, "supervisor.sh");
	try {
		writeFileSync(script, SUPERVISOR_SOURCE, { mode: 0o600, flag: "wx" });
	} catch (error) {
		cleanupSupervisorScript();
		throw error;
	}
	return script;
}

export function supportsWorkerdWatchdog(): boolean {
	return process.platform !== "win32" && existsSync("/bin/sh");
}

function removeExitHandlerIfIdle(): void {
	if (children.size === 0 && watchdogs.size === 0) {
		process.off("exit", state.onExit);
		cleanupSupervisorScript();
	}
}

export function spawnWorkerd(binary: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
	const supervised = supportsWorkerdWatchdog();
	// Keep the script out of the module directory so consumer bundles can relocate the code.
	const script = supervised ? supervisorScript() : undefined;
	let child: ChildProcess;
	try {
		child = script
			? spawn("/bin/sh", [script, "start", binary, ...args], {
					detached: true,
					stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
					env,
				})
			: spawn(binary, args, {
					detached: process.platform !== "win32",
					stdio: ["ignore", "pipe", "pipe", "pipe"],
					env,
				});
	} catch (error) {
		removeExitHandlerIfIdle();
		throw error;
	}
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

	if (script && child.pid !== undefined) {
		// Keep the watchdog parented to Node so Node also reaps it when running as PID 1.
		let watchdog: ChildProcess;
		try {
			watchdog = spawn("/bin/sh", [script, "watch", String(child.pid)], {
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
