import { afterEach, describe, expect, it, vi } from "vitest";

const miniflareState = vi.hoisted(() => {
	let resolveReady: () => void;
	let rejectReady: (reason: unknown) => void;
	let ready: Promise<void>;

	const reset = () => {
		ready = new Promise<void>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
	};

	class FakeMiniflare {
		readonly ready: Promise<void>;

		constructor() {
			this.ready = ready;
		}

		async dispose(): Promise<void> {}
	}

	reset();
	return {
		FakeMiniflare,
		reset,
		resolveReady: () => resolveReady(),
		rejectReady: (reason: unknown) => rejectReady(reason),
	};
});

vi.mock("miniflare", () => ({ Miniflare: miniflareState.FakeMiniflare }));

import { MiniflareDevRunner } from "../src/sandbox/dev-runner.js";

const manifest = {
	id: "readiness-test",
	version: "1.0.0",
	capabilities: [],
	storage: {},
};

describe("MiniflareDevRunner readiness", () => {
	let runner: MiniflareDevRunner | null = null;

	afterEach(async () => {
		await runner?.terminateAll();
		runner = null;
		vi.restoreAllMocks();
	});

	it("waits for Miniflare readiness", async () => {
		miniflareState.reset();
		runner = new MiniflareDevRunner({ db: null as never });
		await runner.load(manifest, "export default {};");

		let settled = false;
		const readiness = runner.ensureRunning().finally(() => {
			settled = true;
		});
		await Promise.resolve();
		expect(settled).toBe(false);

		miniflareState.resolveReady();
		await readiness;
		expect(settled).toBe(true);
	});

	it("propagates a Miniflare readiness failure", async () => {
		miniflareState.reset();
		runner = new MiniflareDevRunner({ db: null as never });
		await runner.load(manifest, "export default {};");
		const error = new Error("startup failed");

		const readiness = runner.ensureRunning();
		miniflareState.rejectReady(error);

		await expect(readiness).rejects.toBe(error);
	});

	it("classifies a rejected hook transport as sandbox unavailable", async () => {
		miniflareState.reset();
		runner = new MiniflareDevRunner({ db: null as never });
		const plugin = await runner.load(manifest, "export default {};");
		vi.spyOn(runner, "dispatchToPlugin").mockRejectedValue(new TypeError("connection lost"));

		await expect(plugin.invokeHook("content:afterSave", {})).rejects.toMatchObject({
			name: "SandboxUnavailableError",
		});
	});

	it("classifies a non-OK hook response as a plugin error", async () => {
		miniflareState.reset();
		runner = new MiniflareDevRunner({ db: null as never });
		const plugin = await runner.load(manifest, "export default {};");
		vi.spyOn(runner, "dispatchToPlugin").mockResolvedValue(
			new Response("hook failed", { status: 500 }),
		);

		await expect(plugin.invokeHook("content:afterSave", {})).rejects.toMatchObject({
			name: "Error",
		});
	});
});
