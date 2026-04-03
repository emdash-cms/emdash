/**
 * Multi-tab cache coordination via BroadcastChannel.
 *
 * When one tab writes to IndexedDB (after a fetch or mutation), it broadcasts
 * the affected query keys so other tabs can invalidate their TanStack Query
 * caches and show fresh data.
 */

import type { QueryClient } from "@tanstack/react-query";

const CHANNEL_NAME = "emdash-cache";

interface CacheMessage {
	type: "invalidate";
	queryKeys: string[][];
}

let channel: BroadcastChannel | null = null;

function getChannel(): BroadcastChannel | null {
	if (typeof BroadcastChannel === "undefined") return null;
	if (!channel) {
		channel = new BroadcastChannel(CHANNEL_NAME);
	}
	return channel;
}

/**
 * Broadcast that certain query keys should be invalidated in other tabs.
 */
export function broadcastInvalidation(queryKeys: string[][]): void {
	const ch = getChannel();
	if (!ch) return;
	try {
		const message: CacheMessage = { type: "invalidate", queryKeys };
		// oxlint-disable-next-line unicorn/require-post-message-target-origin -- BroadcastChannel doesn't take targetOrigin
		ch.postMessage(message);
	} catch {
		// BroadcastChannel may fail in certain contexts
	}
}

/**
 * Listen for cache invalidation messages from other tabs.
 * Call this once with the QueryClient to set up cross-tab sync.
 * Returns a cleanup function to stop listening.
 */
export function listenForInvalidations(queryClient: QueryClient): () => void {
	const ch = getChannel();
	if (!ch) return () => {};

	function handleMessage(event: MessageEvent) {
		const data = event.data as CacheMessage;
		if (data?.type === "invalidate" && Array.isArray(data.queryKeys)) {
			for (const queryKey of data.queryKeys) {
				void queryClient.invalidateQueries({ queryKey });
			}
		}
	}

	ch.addEventListener("message", handleMessage);
	return () => {
		ch.removeEventListener("message", handleMessage);
	};
}

/**
 * Close the broadcast channel. Called on cleanup.
 */
export function closeBroadcastChannel(): void {
	if (channel) {
		channel.close();
		channel = null;
	}
}
