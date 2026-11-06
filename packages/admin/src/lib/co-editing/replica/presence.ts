import type { Awareness } from "y-protocols/awareness";

import type { PresencePeer } from "../types.js";

/**
 * The other clients in the room, by client ID. The room stamps each state's `user` from its token,
 * so a state without one isn't a client the room let in.
 */
export function readPeers(awareness: Awareness): PresencePeer[] {
	const peers: PresencePeer[] = [];
	for (const [clientId, state] of awareness.getStates()) {
		if (clientId === awareness.clientID) continue;
		const user: unknown = state.user;
		if (!isRecord(user) || typeof user.id !== "string" || typeof user.name !== "string") continue;
		const field = typeof state.field === "string" ? state.field : null;
		peers.push({ clientId, user: { id: user.id, name: user.name }, field });
	}
	return peers.toSorted((a, b) => a.clientId - b.clientId);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
