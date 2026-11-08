import { CLOSE_CODES, isRoomToken, parseRoomId, roomIdFromPath } from "emdash/internal/co-editing";

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
	const token = url.searchParams.get("token");
	if (token === null) return null;
	const roomId = roomIdFromPath(url.pathname);
	const rooms = roomsBinding(env);
	if (!roomId || !parseRoomId(roomId) || !rooms) return null;
	// Any name creates its Durable Object, so a token no room could have issued stops here.
	if (!isRoomToken(token)) return Promise.resolve(refuseSocket());
	return rooms.getByName(roomId).fetch(request);
}

/** Closes the socket with `busy`, as a room does for a token it doesn't hold. */
function refuseSocket(): Response {
	const { 0: client, 1: server } = new WebSocketPair();
	server.accept();
	server.close(CLOSE_CODES.busy, "No valid token");
	return new Response(null, { status: 101, webSocket: client });
}
