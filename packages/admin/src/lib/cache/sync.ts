/**
 * Background sync manager for the EmDash admin cache.
 *
 * Periodically refetches data in the background to keep the IndexedDB cache
 * and TanStack Query cache fresh. Pauses when the tab is hidden and triggers
 * an immediate sync on tab re-focus.
 */

import type { QueryClient } from "@tanstack/react-query";

import { broadcastInvalidation } from "./broadcast.js";

export type SyncStatus = "idle" | "syncing" | "synced" | "offline" | "error";

interface SyncGroup {
	/** Query keys to invalidate for this group */
	queryKeys: string[][];
	/** Polling interval in milliseconds */
	interval: number;
	/** Last sync timestamp */
	lastSyncAt: number;
}

const SYNC_GROUPS: Record<string, SyncGroup> = {
	content: {
		queryKeys: [["content"], ["media"]],
		interval: 30_000, // 30 seconds
		lastSyncAt: 0,
	},
	users: {
		queryKeys: [["users"], ["bylines"]],
		interval: 60_000, // 60 seconds
		lastSyncAt: 0,
	},
	config: {
		queryKeys: [["manifest"], ["settings"], ["currentUser"]],
		interval: 300_000, // 5 minutes
		lastSyncAt: 0,
	},
	reference: {
		queryKeys: [["menus"], ["menu"], ["sections"], ["taxonomy-def"], ["taxonomy-terms"]],
		interval: 300_000, // 5 minutes
		lastSyncAt: 0,
	},
};

export interface SyncManager {
	/** Start the background sync loop */
	start: () => void;
	/** Stop the background sync loop */
	stop: () => void;
	/** Get the current sync status */
	getStatus: () => SyncStatus;
	/** Subscribe to status changes */
	subscribe: (listener: (status: SyncStatus) => void) => () => void;
	/** Trigger an immediate sync of all groups */
	syncNow: () => void;
}

/**
 * Create a background sync manager.
 *
 * The manager runs a tick loop that checks each sync group's interval.
 * It pauses when the tab is hidden and syncs immediately on re-focus.
 */
export function createSyncManager(queryClient: QueryClient): SyncManager {
	let status: SyncStatus = "idle";
	let tickTimer: ReturnType<typeof setInterval> | null = null;
	let running = false;
	const listeners = new Set<(status: SyncStatus) => void>();

	function setStatus(newStatus: SyncStatus) {
		if (status === newStatus) return;
		status = newStatus;
		for (const listener of listeners) {
			listener(newStatus);
		}
	}

	async function syncGroup(group: SyncGroup): Promise<void> {
		const now = Date.now();
		if (now - group.lastSyncAt < group.interval) return;

		group.lastSyncAt = now;

		const promises = group.queryKeys.map((queryKey) => queryClient.invalidateQueries({ queryKey }));

		await Promise.allSettled(promises);

		// Notify other tabs
		broadcastInvalidation(group.queryKeys);
	}

	async function tick() {
		if (!running) return;

		// Don't sync when the tab is hidden
		if (document.hidden) return;

		// Check if we're online
		if (!navigator.onLine) {
			setStatus("offline");
			return;
		}

		setStatus("syncing");

		try {
			const groups = Object.values(SYNC_GROUPS);
			await Promise.allSettled(groups.map((group) => syncGroup(group)));
			setStatus("synced");
		} catch {
			setStatus("error");
		}
	}

	function handleVisibilityChange() {
		if (!running) return;
		if (!document.hidden) {
			// Tab became visible -- trigger immediate sync
			void tick();
		}
	}

	function handleOnline() {
		if (!running) return;
		setStatus("idle");
		void tick();
	}

	function handleOffline() {
		if (!running) return;
		setStatus("offline");
	}

	return {
		start() {
			if (running) return;
			running = true;
			setStatus("idle");

			// Tick every 10 seconds to check intervals
			tickTimer = setInterval(() => void tick(), 10_000);

			document.addEventListener("visibilitychange", handleVisibilityChange);
			window.addEventListener("online", handleOnline);
			window.addEventListener("offline", handleOffline);

			// Initial sync after a short delay to not interfere with page load
			setTimeout(() => void tick(), 5_000);
		},

		stop() {
			running = false;
			if (tickTimer) {
				clearInterval(tickTimer);
				tickTimer = null;
			}
			document.removeEventListener("visibilitychange", handleVisibilityChange);
			window.removeEventListener("online", handleOnline);
			window.removeEventListener("offline", handleOffline);
			setStatus("idle");
		},

		getStatus() {
			return status;
		},

		subscribe(listener: (status: SyncStatus) => void) {
			listeners.add(listener);
			return () => {
				listeners.delete(listener);
			};
		},

		syncNow() {
			// Reset all lastSyncAt to force immediate sync
			for (const group of Object.values(SYNC_GROUPS)) {
				group.lastSyncAt = 0;
			}
			void tick();
		},
	};
}
