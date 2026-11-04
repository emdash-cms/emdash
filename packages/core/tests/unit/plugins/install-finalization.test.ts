import { describe, expect, it, vi } from "vitest";

import {
	finalizePluginInstall,
	finalizePluginUpdate,
} from "../../../src/plugins/install-finalization.js";

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

describe("finalizePluginUpdate", () => {
	it("restores and reactivates the previous version after activation failure", async () => {
		const calls: string[] = [];
		let syncCount = 0;
		await expect(
			finalizePluginUpdate({
				pluginId: "gallery",
				syncRuntime: async () => {
					syncCount += 1;
					calls.push(`sync-${syncCount}`);
				},
				runLifecycle: async () => {
					calls.push("activate-update");
					throw new Error("activate failed");
				},
				rollback: async () => {
					calls.push("rollback");
					return { success: true as const, data: {} };
				},
				runRollbackLifecycle: async () => {
					calls.push("activate-previous");
				},
			}),
		).rejects.toThrow("activate failed");
		expect(calls).toEqual(["sync-1", "activate-update", "rollback", "sync-2", "activate-previous"]);
	});

	it("does not activate the previous version when persistence rollback fails", async () => {
		const runRollbackLifecycle = vi.fn(async () => undefined);
		await expect(
			finalizePluginUpdate({
				pluginId: "gallery",
				syncRuntime: vi.fn(async () => undefined),
				runLifecycle: vi.fn(async () => {
					throw new Error("activate failed");
				}),
				rollback: vi.fn(async () => ({
					success: false as const,
					error: { code: "UPDATE_ROLLBACK_CONFLICT", message: "state changed" },
				})),
				runRollbackLifecycle,
			}),
		).rejects.toThrow("rollback did not complete");
		expect(runRollbackLifecycle).not.toHaveBeenCalled();
	});
});
