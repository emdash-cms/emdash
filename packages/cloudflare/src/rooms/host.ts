/**
 * The Worker-side room host, `@emdash-cms/cloudflare/internal/rooms`: routes reach each room by
 * RPC through the `EMDASH_ROOMS` binding. Only `virtual:emdash/rooms` imports it, on Cloudflare
 * with co-editing on, and it loads no room code itself.
 */

import { env } from "cloudflare:workers";
import { RoomSaveError, type RuntimeRoomHost } from "emdash/internal/co-editing";
import { setRoomNotifier } from "emdash/internal/co-editing/notifications";

import { roomsBinding } from "./binding.js";

/** Rooms in Durable Objects, or null without the `EMDASH_ROOMS` binding. */
export function createRoomHost(): RuntimeRoomHost | null {
	const rooms = roomsBinding(env);
	if (!rooms) return null;
	const room = (roomId: string) => rooms.getByName(roomId);
	const host: RuntimeRoomHost = {
		issueToken: (roomId, claims) => room(roomId).issueToken(claims),
		isOpen: (roomId) => room(roomId).isOpen(),
		async save(roomId, actorId, rev) {
			const reply = await room(roomId).save(actorId, rev);
			if (reply !== null && typeof reply === "object" && "failed" in reply) {
				const { reason, code, message } = reply.failed;
				throw new RoomSaveError(reason, code, message);
			}
			return reply;
		},
		release: (roomId, hold, options) => room(roomId).release(hold, options),
		notify: (roomId, outside) => room(roomId).notify(outside),
		forgetTokens: (roomId, userId) => room(roomId).forgetTokens(userId),
		// Alarms drop rooms, and Workers sends no shutdown signal.
		expireIdle: async () => {},
		shutdown: async () => {},
		activate() {
			setRoomNotifier(host);
		},
	};
	return host;
}
