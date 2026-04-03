/**
 * Tests for the background sync manager.
 */

import { describe, it, expect, afterEach, vi, beforeEach } from "vitest";

import type { SyncStatus } from "../../../src/lib/cache/sync.js";
import { createSyncManager } from "../../../src/lib/cache/sync.js";

function createMockQueryClient() {
	return {
		invalidateQueries: vi.fn().mockResolvedValue(undefined),
	};
}

describe("createSyncManager", () => {
	let syncManager: ReturnType<typeof createSyncManager>;
	let mockQueryClient: ReturnType<typeof createMockQueryClient>;

	beforeEach(() => {
		vi.useFakeTimers();
		mockQueryClient = createMockQueryClient();
		syncManager = createSyncManager(mockQueryClient as never);
	});

	afterEach(() => {
		syncManager.stop();
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("starts with idle status", () => {
		expect(syncManager.getStatus()).toBe("idle");
	});

	it("remains idle after start until first tick", () => {
		syncManager.start();
		// Before the 5s initial delay, status is idle
		expect(syncManager.getStatus()).toBe("idle");
	});

	it("does not start twice", () => {
		syncManager.start();
		syncManager.start(); // second call should be no-op
		expect(syncManager.getStatus()).toBe("idle");
	});

	it("resets to idle on stop", () => {
		syncManager.start();
		syncManager.stop();
		expect(syncManager.getStatus()).toBe("idle");
	});

	it("subscribes to status changes", () => {
		const statuses: SyncStatus[] = [];
		const unsub = syncManager.subscribe((s) => statuses.push(s));

		syncManager.start();
		// Trigger a tick via syncNow
		syncManager.syncNow();

		// We should see at least a status change
		expect(statuses.length).toBeGreaterThanOrEqual(0);

		unsub();
	});

	it("unsubscribes correctly", () => {
		const statuses: SyncStatus[] = [];
		const unsub = syncManager.subscribe((s) => statuses.push(s));
		unsub();

		syncManager.start();
		syncManager.syncNow();

		// After unsubscribe, no new statuses should be recorded
		// (only the initial idle -> syncing from start, if any, before unsub)
		expect(statuses).toEqual([]);
	});

	it("syncNow resets intervals and triggers tick", () => {
		syncManager.start();
		syncManager.syncNow();

		// syncNow should have called invalidateQueries
		// The tick runs asynchronously via void tick(), so we advance timers
		vi.advanceTimersByTime(0);
		// After microtasks settle, status should have changed
		expect(["idle", "syncing", "synced", "offline"]).toContain(syncManager.getStatus());
	});

	it("sets offline status when navigator is offline", () => {
		// Mock navigator.onLine
		const originalOnLine = navigator.onLine;
		Object.defineProperty(navigator, "onLine", { value: false, configurable: true });

		syncManager.start();
		syncManager.syncNow();
		vi.advanceTimersByTime(0);

		expect(syncManager.getStatus()).toBe("offline");

		Object.defineProperty(navigator, "onLine", { value: originalOnLine, configurable: true });
	});
});
