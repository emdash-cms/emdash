import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";

const CHILDREN_KEY = Symbol.for("emdash.workerd-children");
const childrenGlobal = globalThis as typeof globalThis & {
	[CHILDREN_KEY]?: { children: Set<ChildProcess>; onExit: () => void };
};
const state = (childrenGlobal[CHILDREN_KEY] ??= {
	children: new Set<ChildProcess>(),
	onExit: killChildren,
});
const children = state.children;

function killChildren(): void {
	for (const child of children) signalWorkerd(child, "SIGKILL");
}

/** Signal the whole POSIX process group, including any binary launcher. */
export function signalWorkerd(child: ChildProcess, signal: NodeJS.Signals): void {
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

// The watchdog owns only the read end of fd 4. EOF also arrives when the host
// is SIGKILLed, when no JavaScript exit or signal handler can run. It must not
// hold the control/output pipes open after workerd exits.
const SUPERVISOR = `
(
	trap '' TERM INT
	while read -r line; do :; done
	kill -KILL -"$$"
) <&4 3>&- 4<&- >/dev/null 2>&1 &
exec "$@" 4<&-
`;

export function spawnWorkerd(binary: string, args: string[], env: NodeJS.ProcessEnv): ChildProcess {
	const posix = process.platform !== "win32";
	const child =
		posix && existsSync("/bin/sh")
			? spawn("/bin/sh", ["-c", SUPERVISOR, "emdash-workerd", binary, ...args], {
					detached: true,
					stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
					env,
				})
			: spawn(binary, args, { detached: posix, stdio: ["ignore", "pipe", "pipe", "pipe"], env });
	if (children.size === 0) process.on("exit", state.onExit);
	children.add(child);
	child.once("close", () => {
		// Closing the lifetime pipe also reaps launcher descendants on crashes.
		const lifetime = child.stdio[4];
		if (lifetime && "destroy" in lifetime) lifetime.destroy();
		children.delete(child);
		if (children.size === 0) process.off("exit", state.onExit);
	});
	// 'close' waits for inherited pipes, so release the watchdog on exit first.
	child.once("exit", () => {
		const lifetime = child.stdio[4];
		if (lifetime && "destroy" in lifetime) lifetime.destroy();
	});
	return child;
}
