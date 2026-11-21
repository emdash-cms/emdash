import type { ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

/** Learn kernel-assigned socket ports before probing the spawned configuration. */
export function waitForWorkerdReady(
	proc: ChildProcess,
	sockets: ReadonlyMap<string, { port: number }>,
	probe: () => Promise<boolean>,
	timeoutMs = 10_000,
): Promise<void> {
	return new Promise((resolve, reject) => {
		const pipe = proc.stdio[3];
		if (!pipe || !("readable" in pipe)) {
			reject(new Error("[emdash:workerd] workerd control pipe is unavailable"));
			return;
		}
		const control = pipe;
		const lines = createInterface({ input: control });
		const pending = new Set(sockets.keys());
		let stderr = "";
		let finished = false;
		let exitReason: string | undefined;
		let probeTimer: ReturnType<typeof setTimeout> | undefined;
		const timeout = setTimeout(
			finish,
			timeoutMs,
			`workerd failed to start within ${timeoutMs / 1000} seconds`,
		);

		function finish(reason?: string): void {
			if (finished) return;
			finished = true;
			clearTimeout(timeout);
			clearTimeout(probeTimer);
			control.on("error", () => {});
			lines.removeAllListeners("line");
			lines.close();
			control.resume();
			proc.off("error", onError);
			proc.off("exit", onExit);
			proc.off("close", onClose);
			proc.stderr?.off("data", onStderr);
			if (reason) {
				reject(new Error(`[emdash:workerd] ${reason}${stderr.trim() ? `: ${stderr.trim()}` : ""}`));
			} else {
				resolve();
			}
		}

		function onStderr(chunk: Buffer): void {
			stderr = (stderr + chunk.toString()).slice(-8192);
		}
		function onError(error: Error): void {
			finish(`workerd failed to start: ${error.message}`);
		}
		function onExit(code: number | null, signal: NodeJS.Signals | null): void {
			exitReason = `workerd exited during startup with ${signal ? `signal ${signal}` : `code ${code}`}`;
		}
		// Child close follows exit and drains stderr, including the cause of startup failure.
		function onClose(): void {
			finish(exitReason ?? "workerd closed before reporting all plugin ports");
		}
		async function checkReady(): Promise<void> {
			const ready = await probe();
			if (finished || exitReason) return;
			if (ready) {
				finish();
				return;
			}
			if (!finished && !exitReason) probeTimer = setTimeout(() => void checkReady(), 100);
		}

		proc.on("error", onError);
		proc.on("exit", onExit);
		proc.on("close", onClose);
		proc.stderr?.on("data", onStderr);
		lines.on("error", onError);
		lines.on("line", (line: string) => {
			try {
				const message: unknown = JSON.parse(line);
				if (!message || typeof message !== "object" || !("event" in message)) return;
				if (message.event !== "listen") return;
				if (
					!("socket" in message) ||
					typeof message.socket !== "string" ||
					!("port" in message) ||
					typeof message.port !== "number" ||
					!Number.isInteger(message.port) ||
					message.port < 1 ||
					message.port > 65535
				) {
					finish("workerd reported an invalid listening port");
					return;
				}
				const plugin = sockets.get(message.socket);
				if (!plugin || !pending.delete(message.socket)) return;
				plugin.port = message.port;
				if (pending.size === 0) void checkReady();
			} catch {
				finish("workerd reported an invalid control message");
			}
		});
		if (pending.size === 0) void checkReady();
	});
}
