/** Verifies the runner executes workerd's exported native binary, not its CLI shim. */

import { afterEach, describe, expect, it, vi } from "vitest";

const { nativeBinaryPath, workerdRequire, createRequire } = vi.hoisted(() => {
	const binaryPath = process.execPath;
	const packageRequire = Object.assign(
		vi.fn<() => unknown>(() => ({ default: binaryPath })),
		{ resolve: vi.fn(() => "/nonexistent/bin/workerd-cli.js") },
	);
	return {
		nativeBinaryPath: binaryPath,
		workerdRequire: packageRequire,
		createRequire: vi.fn(() => packageRequire),
	};
});

vi.mock("node:module", () => ({ createRequire }));

import { WorkerdSandboxRunner } from "../src/sandbox/runner.js";

describe("workerd native binary resolution", () => {
	let runner: WorkerdSandboxRunner;
	afterEach(async () => {
		await runner?.terminateAll();
		vi.restoreAllMocks();
		workerdRequire.mockImplementation(() => ({ default: nativeBinaryPath }));
	});

	it("checks the exported native path instead of the CLI wrapper", () => {
		runner = new WorkerdSandboxRunner({ db: null as never });

		expect(runner.isAvailable()).toBe(true);
	});

	it("falls back to PATH when the package does not export a binary", () => {
		workerdRequire.mockImplementation(() => ({ invalid: nativeBinaryPath }));
		runner = new WorkerdSandboxRunner({ db: null as never });

		expect(runner["resolveWorkerdBinary"]()).toBe("workerd");
	});
});
