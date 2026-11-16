import { ChildProcess } from "node:child_process";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import { waitForWorkerdReady } from "../src/sandbox/workerd-startup.js";

function makeProcess(): { child: ChildProcess; control: PassThrough; stderr: PassThrough } {
	const child = new ChildProcess();
	const control = new PassThrough();
	const stderr = new PassThrough();
	Object.defineProperty(child, "stdio", { value: [null, null, stderr, control] });
	Object.defineProperty(child, "stderr", { value: stderr });
	return { child, control, stderr };
}

function send(control: PassThrough, messages: string[], splitAt = 0): void {
	const data = `${messages.join("\n")}\n`;
	if (splitAt > 0) {
		control.write(data.slice(0, splitAt));
		control.write(data.slice(splitAt));
	} else {
		control.write(data);
	}
}

describe("waitForWorkerdReady", () => {
	it("waits for every socket and updates each mapping with its actual port", async () => {
		const { child, control } = makeProcess();
		const sockets = new Map([
			["first", { port: 0 }],
			["second", { port: 0 }],
		]);
		const probe = vi.fn(async () => {
			expect(Array.from(sockets.values(), ({ port }) => port)).toEqual([41001, 41002]);
			return true;
		});
		const ready = waitForWorkerdReady(child, sockets, probe);

		send(control, [JSON.stringify({ event: "listen", socket: "first", port: 41001 })], 7);
		await Promise.resolve();
		expect(probe).not.toHaveBeenCalled();
		send(control, [
			JSON.stringify({ event: "listen", socket: "missing", port: 41003 }),
			JSON.stringify({ event: "connected", socket: "second", port: 41002 }),
			JSON.stringify({ event: "listen", socket: "second", port: 41002 }),
		]);

		await ready;
		expect(() => control.emit("error", new Error("pipe closed"))).not.toThrow();
		expect(probe).toHaveBeenCalledOnce();
		expect(sockets.get("first")?.port).toBe(41001);
		expect(sockets.get("second")?.port).toBe(41002);
	});

	it("rejects promptly with captured stderr when workerd exits", async () => {
		const { child, control, stderr } = makeProcess();
		const ready = waitForWorkerdReady(child, new Map([["plugin", { port: 0 }]]), async () => true);
		stderr.write("Socket: bind(): Address already in use (os error 98)\n");
		child.emit("exit", 1, null);
		child.emit("close", 1, null);
		await expect(ready).rejects.toThrow(/exited during startup.*Address already in use/);
		control.destroy();
	});

	it("reports a spawn error", async () => {
		const { child } = makeProcess();
		const ready = waitForWorkerdReady(child, new Map(), async () => true);
		child.emit("error", Object.assign(new Error("spawn workerd ENOENT"), { code: "ENOENT" }));
		await expect(ready).rejects.toThrow("spawn workerd ENOENT");
	});

	it.each([
		["malformed JSON", "not json", "invalid control message"],
		[
			"invalid port",
			JSON.stringify({ event: "listen", socket: "plugin", port: 0 }),
			"invalid listening port",
		],
	])("rejects %s control messages", async (_name, message, expected) => {
		const { child, control } = makeProcess();
		const ready = waitForWorkerdReady(child, new Map([["plugin", { port: 0 }]]), async () => true);
		control.write(`${message}\n`);
		await expect(ready).rejects.toThrow(expected);
	});

	it("preserves trailing stderr after the control pipe closes", async () => {
		const { child, control, stderr } = makeProcess();
		const ready = waitForWorkerdReady(child, new Map([["plugin", { port: 0 }]]), async () => true);
		control.end();
		child.emit("exit", 1, null);
		stderr.write("bind(): Address already in use");
		child.emit("close", 1, null);
		await expect(ready).rejects.toThrow("Address already in use");
	});

	it("times out", async () => {
		vi.useFakeTimers();
		try {
			const { child } = makeProcess();
			const ready = waitForWorkerdReady(
				child,
				new Map([["plugin", { port: 0 }]]),
				async () => true,
				25,
			);
			const rejection = expect(ready).rejects.toThrow("failed to start within 0.025 seconds");
			await vi.advanceTimersByTimeAsync(25);
			await rejection;
		} finally {
			vi.useRealTimers();
		}
	});

	it("retries a failed probe", async () => {
		vi.useFakeTimers();
		try {
			const { child, control } = makeProcess();
			const probe = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
			const ready = waitForWorkerdReady(child, new Map([["plugin", { port: 41001 }]]), probe);
			send(control, [JSON.stringify({ event: "listen", socket: "plugin", port: 41001 })]);
			await vi.advanceTimersByTimeAsync(0);
			expect(probe).toHaveBeenCalledOnce();
			await vi.advanceTimersByTimeAsync(100);
			await ready;
			expect(probe).toHaveBeenCalledTimes(2);
		} finally {
			vi.useRealTimers();
		}
	});

	it("cannot succeed if workerd exits during a pending probe and cleans up", async () => {
		let resolveProbe!: (ready: boolean) => void;
		const { child, control, stderr } = makeProcess();
		const probe = vi.fn(() => new Promise<boolean>((resolve) => (resolveProbe = resolve)));
		const ready = waitForWorkerdReady(child, new Map([["plugin", { port: 41001 }]]), probe);
		send(control, [JSON.stringify({ event: "listen", socket: "plugin", port: 41001 })]);
		await Promise.resolve();
		child.emit("exit", 1, null);
		child.emit("close", 1, null);
		resolveProbe(true);
		await expect(ready).rejects.toThrow("exited during startup");
		expect(child.listenerCount("exit")).toBe(0);
		expect(child.listenerCount("error")).toBe(0);
		expect(stderr.listenerCount("data")).toBe(0);
		control.destroy();
	});
});
