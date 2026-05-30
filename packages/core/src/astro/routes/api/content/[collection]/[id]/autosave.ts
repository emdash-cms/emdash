/**
 * Builder autosave endpoint
 *
 * POST /_emdash/api/content/{collection}/{id}/autosave
 *
 * Accepts Lexical JSON, converts to BuilderDocument, validates,
 * and saves as a draft revision.
 *
 * Does NOT update the content table columns — only creates a revision.
 * The content table is updated only on explicit publish.
 */
import { hasPermission } from "@emdash-cms/auth";
import type { APIRoute } from "astro";

import { requireOwnerPerm } from "#api/authorize.js";
import { apiError, mapErrorStatus, unwrapResult } from "#api/error.js";
import { parseBody, isParseError } from "#api/parse.js";

const autosaveBodySchema = {
	type: "object" as const,
	properties: {
		content: { type: "string" as const },
		field: { type: "string" as const },
	},
	required: ["content"],
	additionalProperties: false,
};

export const prerender = false;

export const POST: APIRoute = async ({ params, request, locals }) => {
	const { emdash, user } = locals;
	const collection = params.collection!;
	const id = params.id!;

	if (!emdash?.handleContentAutosave || !emdash?.handleContentGet) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	// Parse body
	const body = await parseBody(request, autosaveBodySchema);
	if (isParseError(body)) return body;

	// Fetch the content item to check it exists and get authorId for ownership
	const existing = await emdash.handleContentGet(collection, id);
	if (!existing.success) {
		return apiError(
			existing.error?.code ?? "NOT_FOUND",
			existing.error?.message ?? "Content not found",
			mapErrorStatus(existing.error?.code),
		);
	}

	const existingData =
		existing.data && typeof existing.data === "object"
			? // eslint-disable-next-line typescript/no-explicit-any
				(existing.data as Record<string, unknown>)
			: undefined;
	const existingItem =
		existingData?.item && typeof existingData.item === "object"
			? // eslint-disable-next-line typescript/no-explicit-any
				(existingData.item as Record<string, unknown>)
			: existingData;
	const authorId = typeof existingItem?.authorId === "string" ? existingItem.authorId : "";

	// Auth check
	const editDenied = requireOwnerPerm(user, authorId, "content:edit_own", "content:edit_any");
	if (editDenied) return editDenied;

	// Parse Lexical JSON
	let lexicalJson: unknown;
	try {
		lexicalJson = JSON.parse(body.content);
	} catch {
		return apiError("VALIDATION_ERROR", "Invalid JSON in content field", 400);
	}

	const result = await emdash.handleContentAutosave(
		collection,
		id,
		lexicalJson,
		user?.id,
		body.field,
	);

	if (!result.success) {
		return apiError(result.error.code, result.error.message, mapErrorStatus(result.error.code));
	}

	return new Response(JSON.stringify({ success: true, revisionId: result.data!.revisionId }), {
		status: 200,
		headers: { "Content-Type": "application/json" },
	});
};
