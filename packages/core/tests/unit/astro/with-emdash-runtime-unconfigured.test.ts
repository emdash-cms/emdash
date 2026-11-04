/**
 * withEmDashRuntime() error contract (#1887): throws when EmDash is not
 * configured (no `emdash()` Astro integration), unlike `runScheduledTasks`
 * which silently no-ops.
 *
 * Separate file from with-emdash-runtime.test.ts because the
 * `virtual:emdash/config` mock is module-level: this file mocks the
 * unconfigured state (`default: null`), the other one a valid config.
 */

import { describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

vi.mock("virtual:emdash/config", () => ({ default: null }), { virtual: true });

vi.mock(
	"virtual:emdash/dialect",
	() => ({
		createDialect: vi.fn(),
		createRequestScopedDb: vi.fn().mockReturnValue(null),
		createCoalescingDialect: undefined,
	}),
	{ virtual: true },
);

vi.mock("virtual:emdash/media-providers", () => ({ mediaProviders: [] }), { virtual: true });
vi.mock("virtual:emdash/plugins", () => ({ plugins: [] }), { virtual: true });
vi.mock(
	"virtual:emdash/sandbox-runner",
	() => ({ createSandboxRunner: null, sandboxBypassed: false, sandboxEnabled: false }),
	{ virtual: true },
);
vi.mock("virtual:emdash/sandboxed-plugins", () => ({ sandboxedPlugins: [] }), { virtual: true });
vi.mock("virtual:emdash/storage", () => ({ createStorage: null }), { virtual: true });
vi.mock("virtual:emdash/wait-until", () => ({ waitUntil: undefined }), { virtual: true });
vi.mock("virtual:emdash/scheduler", () => ({ createScheduler: null }), { virtual: true });

import { runScheduledTasks, withEmDashRuntime } from "../../../src/astro/middleware.js";

describe("withEmDashRuntime without EmDash config (#1887)", () => {
	it("throws the documented error and never runs the callback", async () => {
		const callback = vi.fn(async () => "should-not-run");

		await expect(withEmDashRuntime(callback)).rejects.toThrow("EmDash is not configured");
		expect(callback).not.toHaveBeenCalled();
	});

	it("runScheduledTasks keeps its silent no-op contract by contrast", async () => {
		await expect(runScheduledTasks()).resolves.toEqual({ published: [] });
	});
});
