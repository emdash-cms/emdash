/** Pins what the runner reports when the workerd binary does not run. */

import { afterEach, describe, expect, it, vi } from "vitest";

import { WorkerdSandboxRunner } from "../src/sandbox/runner.js";

const MISSING_BINARY = "/nonexistent/bin/workerd";
const RUNNABLE_BINARY = process.execPath;

describe("workerd binary check", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("names the binary when it does not run", () => {
		const runner = new WorkerdSandboxRunner({ db: null as any });
		vi.spyOn(runner as any, "resolveWorkerdBinary").mockReturnValue(MISSING_BINARY);

		expect(runner.isAvailable()).toBe(false);
		expect(runner.unavailableReason()).toContain("binary");
	});

	it("drops the binary once a later check runs it", () => {
		const runner = new WorkerdSandboxRunner({ db: null as any });
		const resolve = vi.spyOn(runner as any, "resolveWorkerdBinary").mockReturnValue(MISSING_BINARY);
		runner.isAvailable();
		resolve.mockReturnValue(RUNNABLE_BINARY);

		expect(runner.isAvailable()).toBe(true);
		expect(runner.unavailableReason()).toBe("workerd is not running");
	});
});
