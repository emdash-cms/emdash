import { roomIdFromPath } from "emdash/internal/co-editing";

import { roomsBinding } from "./binding.js";

/**
 * Forwards a room's WebSocket upgrade to its Durable Object, or returns null for any other
 * request. A Worker with its own `fetch` calls this first.
 */
export function handleRoomUpgrade(request: Request, env: unknown): Promise<Response> | null {
	if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
		return null;
	}
	const url = new URL(request.url);
	if (!url.searchParams.has("token")) return null;
	const roomId = roomIdFromPath(url.pathname);
	const rooms = roomsBinding(env);
	if (!roomId || !rooms) return null;
	return rooms.getByName(roomId).fetch(request);
}
