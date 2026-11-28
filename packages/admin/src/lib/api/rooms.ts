/**
 * Co-editing room API: joining an entry's room, and saving a recovery revision.
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { RoomAccess } from "../../co-editing/types.js";
import { API_BASE, apiFetch, parseApiResponse } from "./client.js";

export interface RoomEntry {
	collection: string;
	id: string;
	locale?: string;
}

/** Identifies the EmDash build and the editor schema a client was built from. */
export interface RoomFingerprint {
	version: string;
	commit: string;
	hash: string;
}

export interface JoinRequest {
	fingerprint: RoomFingerprint;
	takeover?: boolean;
	singleEditor?: boolean;
}

export type JoinOutcome =
	| { kind: "room"; url: string; token: string; access: RoomAccess }
	| { kind: "single-editor" }
	/** The room is at a connection limit. */
	| { kind: "full" }
	/** Another user holds the entry's edit lock. */
	| { kind: "locked" }
	/** The room isn't available here right now. */
	| { kind: "busy" }
	/** The fingerprint differs from the server's. */
	| { kind: "outdated" }
	| { kind: "forbidden" }
	/** The entry is in Trash or gone. */
	| { kind: "gone" }
	/** The request didn't reach the server or failed there. */
	| { kind: "failed" };

export interface RecoveryInput {
	data: Record<string, unknown>;
	slug: string | null;
}

/** The 409 refusals a join can get, by error code. */
const CONFLICT_OUTCOMES = new Map<string, JoinOutcome>([
	["ENTRY_LOCKED", { kind: "locked" }],
	["ROOM_BUSY", { kind: "busy" }],
	["CLIENT_OUTDATED", { kind: "outdated" }],
]);

/** Never throws: every response, and a request that fails, maps to an outcome. */
export async function joinRoom(entry: RoomEntry, request: JoinRequest): Promise<JoinOutcome> {
	let response: Response;
	let body: unknown;
	try {
		response = await apiFetch(entryUrl(entry, "room"), {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(request),
		});
		body = await response.json().catch(() => null);
	} catch {
		return { kind: "failed" };
	}
	if (response.ok) return joinedOutcome(isRecord(body) ? body.data : undefined);
	const error = isRecord(body) && isRecord(body.error) ? body.error : undefined;
	const code = typeof error?.code === "string" ? error.code : "";
	const conflict = response.status === 409 ? CONFLICT_OUTCOMES.get(code) : undefined;
	if (conflict) return conflict;
	if (response.status === 401 || response.status === 403) return { kind: "forbidden" };
	if (response.status === 404) return { kind: "gone" };
	return { kind: "failed" };
}

/** Saves a client's whole document as a recovery revision. Rejects with `ApiResponseError`. */
export async function saveRecoveryRevision(entry: RoomEntry, input: RecoveryInput): Promise<void> {
	const response = await apiFetch(entryUrl(entry, "revisions"), {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(input),
	});
	await parseApiResponse<unknown>(response, i18n._(msg`Failed to save a recovery revision`));
}

function joinedOutcome(data: unknown): JoinOutcome {
	if (!isRecord(data)) return { kind: "failed" };
	switch (data.mode) {
		case "room": {
			const { url, token, access } = data;
			if (typeof url !== "string" || typeof token !== "string") return { kind: "failed" };
			if (access !== "edit" && access !== "view") return { kind: "failed" };
			return { kind: "room", url, token, access };
		}
		case "single-editor":
			return { kind: "single-editor" };
		case "read-only":
			return { kind: "full" };
		default:
			return { kind: "failed" };
	}
}

function entryUrl(entry: RoomEntry, action: "room" | "revisions"): string {
	const path = `${API_BASE}/content/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.id)}/${action}`;
	return entry.locale ? `${path}?locale=${encodeURIComponent(entry.locale)}` : path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
