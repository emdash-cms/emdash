import { describe, expect, it, vi } from "vitest";

import { finalizePluginInstall } from "../../../src/plugins/install-finalization.js";

describe("finalizePluginInstall", () => {
	it("runs runtime sync and lifecycle without rollback on success", async () => {
		const syncRuntime = vi.fn(async () => undefined);
		const runLifecycle = vi.fn(async () => undefined);
		const rollback = vi.fn(async () => ({ success: true as const, data: {} }));

		await finalizePluginInstall({ pluginId: "gallery", syncRuntime, runLifecycle, rollback });

		expect(syncRuntime).toHaveBeenCalledOnce();
		expect(runLifecycle).toHaveBeenCalledOnce();
		expect(rollback).not.toHaveBeenCalled();
	});

	it("rolls back persistence and resyncs after lifecycle failure", async () => {
		const calls: string[] = [];
		const syncRuntime = vi.fn(async () => calls.push("sync"));
		const runLifecycle = vi.fn(async () => {
			calls.push("lifecycle");
			throw new Error("activate failed");
		});
		const rollback = vi.fn(async () => {
			calls.push("rollback");
			return { success: true as const, data: {} };
		});

		await expect(
			finalizePluginInstall({ pluginId: "gallery", syncRuntime, runLifecycle, rollback }),
		).rejects.toThrow("activate failed");
		expect(calls).toEqual(["sync", "lifecycle", "rollback", "sync"]);
	});

	it("surfaces incomplete rollback", async () => {
		await expect(
			finalizePluginInstall({
				pluginId: "gallery",
				syncRuntime: vi.fn(async () => undefined),
				runLifecycle: vi.fn(async () => {
					throw new Error("activate failed");
				}),
				rollback: vi.fn(async () => ({
					success: false as const,
					error: { code: "UNINSTALL_FAILED", message: "cleanup failed" },
				})),
			}),
		).rejects.toThrow("rollback did not complete");
	});
});
