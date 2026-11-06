/**
 * Editorial comment threads API
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { EditorialAnchor } from "../../editorial-anchors.js";
import { API_BASE, apiFetch, parseApiResponse } from "./client.js";

export type EditorialAnchorState = "attached" | "orphaned";
export type EditorialThreadStatus = "open" | "resolved";

export interface EditorialPerson {
	id: string;
	name: string | null;
	avatarUrl: string | null;
}

export interface EditorialComment {
	id: string;
	threadId: string;
	/** `null` once the author's account is deleted. */
	author: EditorialPerson | null;
	/** Empty once the comment is deleted. */
	body: string;
	createdAt: string;
	editedAt: string | null;
	deletedAt: string | null;
	can: { edit: boolean; delete: boolean };
}

export interface EditorialThread {
	id: string;
	collection: string;
	entryId: string;
	anchor: EditorialAnchor;
	anchorState: EditorialAnchorState;
	status: EditorialThreadStatus;
	createdBy: string | null;
	resolvedBy: EditorialPerson | null;
	resolvedAt: string | null;
	createdAt: string;
	updatedAt: string;
	comments: EditorialComment[];
	can: { resolve: boolean; delete: boolean };
}

export interface EditorialEntry {
	collection: string;
	id: string;
	locale?: string;
}

export interface EditorialAnchorUpdate {
	threadId: string;
	anchor: EditorialAnchor;
	anchorState: EditorialAnchorState;
}

function threadsUrl(entry: EditorialEntry, path = "", query: Record<string, string> = {}): string {
	const base = `${API_BASE}/content/${encodeURIComponent(entry.collection)}/${encodeURIComponent(entry.id)}/threads${path}`;
	const params = new URLSearchParams(query);
	if (entry.locale) params.set("locale", entry.locale);
	const search = params.toString();
	return search ? `${base}?${search}` : base;
}

function threadPath(threadId: string, rest = ""): string {
	return `/${encodeURIComponent(threadId)}${rest}`;
}

function jsonInit(method: string, body: unknown): RequestInit {
	return {
		method,
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	};
}

/** Every thread on the entry, open and resolved, following each page. */
export async function fetchEditorialThreads(entry: EditorialEntry): Promise<EditorialThread[]> {
	const threads: EditorialThread[] = [];
	let cursor: string | undefined;
	do {
		const query: Record<string, string> = { status: "all", limit: "100" };
		if (cursor) query.cursor = cursor;
		// oxlint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
		const response = await apiFetch(threadsUrl(entry, "", query));
		// oxlint-disable-next-line no-await-in-loop -- each page needs the previous page's cursor
		const page = await parseApiResponse<{ items: EditorialThread[]; nextCursor?: string }>(
			response,
			i18n._(msg`Failed to load comments`),
		);
		threads.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor);
	return threads;
}

export async function createEditorialThread(
	entry: EditorialEntry,
	input: { anchor: EditorialAnchor; body: string; _rev?: string },
): Promise<EditorialThread> {
	const response = await apiFetch(threadsUrl(entry), jsonInit("POST", input));
	return parseApiResponse<EditorialThread>(response, i18n._(msg`Failed to add the comment`));
}

export async function replyToEditorialThread(
	entry: EditorialEntry,
	threadId: string,
	body: string,
): Promise<EditorialThread> {
	const response = await apiFetch(
		threadsUrl(entry, threadPath(threadId, "/comments")),
		jsonInit("POST", { body }),
	);
	return parseApiResponse<EditorialThread>(response, i18n._(msg`Failed to reply`));
}

export async function setEditorialThreadStatus(
	entry: EditorialEntry,
	threadId: string,
	status: EditorialThreadStatus,
): Promise<EditorialThread> {
	const response = await apiFetch(
		threadsUrl(entry, threadPath(threadId)),
		jsonInit("PATCH", { status }),
	);
	return parseApiResponse<EditorialThread>(response, i18n._(msg`Failed to update the thread`));
}

export async function deleteEditorialThread(entry: EditorialEntry, threadId: string) {
	const response = await apiFetch(threadsUrl(entry, threadPath(threadId)), { method: "DELETE" });
	return parseApiResponse<{ deleted: true; threadId: string }>(
		response,
		i18n._(msg`Failed to delete the thread`),
	);
}

export async function editEditorialComment(
	entry: EditorialEntry,
	threadId: string,
	commentId: string,
	body: string,
): Promise<EditorialThread> {
	const response = await apiFetch(
		threadsUrl(entry, threadPath(threadId, `/comments/${encodeURIComponent(commentId)}`)),
		jsonInit("PATCH", { body }),
	);
	return parseApiResponse<EditorialThread>(response, i18n._(msg`Failed to edit the comment`));
}

export async function deleteEditorialComment(
	entry: EditorialEntry,
	threadId: string,
	commentId: string,
) {
	const response = await apiFetch(
		threadsUrl(entry, threadPath(threadId, `/comments/${encodeURIComponent(commentId)}`)),
		{ method: "DELETE" },
	);
	return parseApiResponse<{ threadDeleted: boolean; thread: EditorialThread | null }>(
		response,
		i18n._(msg`Failed to delete the comment`),
	);
}

export async function updateEditorialAnchors(
	entry: EditorialEntry,
	input: { _rev?: string; anchors: EditorialAnchorUpdate[] },
) {
	const response = await apiFetch(threadsUrl(entry, "/anchors"), jsonInit("PATCH", input));
	return parseApiResponse<{ updated: number }>(
		response,
		i18n._(msg`Failed to update comment positions`),
	);
}
