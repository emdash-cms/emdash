/**
 * Content route locale forwarding.
 *
 * When a ?locale query param is present, single-item write routes must
 * forward it to handleContentGet so slug-based lookups resolve to the
 * correct i18n variant instead of returning the first matching row.
 */

import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

import {
	PUT as putItem,
	DELETE as deleteItem,
} from "../../../src/astro/routes/api/content/[collection]/[id].js";
import { POST as postDiscard } from "../../../src/astro/routes/api/content/[collection]/[id]/discard-draft.js";
import { POST as postPublish } from "../../../src/astro/routes/api/content/[collection]/[id]/publish.js";
import {
	POST as postSchedule,
	DELETE as deleteSchedule,
} from "../../../src/astro/routes/api/content/[collection]/[id]/schedule.js";
import { POST as postUnpublish } from "../../../src/astro/routes/api/content/[collection]/[id]/unpublish.js";
import { POST as refreshVisualActionToken } from "../../../src/astro/routes/api/visual-editing/action-token.js";
import { POST as postVisualPublish } from "../../../src/astro/routes/api/visual-editing/content/[collection]/[id]/publish.js";
import { resolveSecretsCached } from "../../../src/config/secrets.js";
import type { Database } from "../../../src/database/types.js";
import {
	generateVisualEditingActionToken,
	verifyVisualEditingActionToken,
} from "../../../src/visual-editing/action-token.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const editor = { id: "u-edit", role: Role.EDITOR };

let db: Kysely<Database>;

beforeAll(async () => {
	db = await setupTestDatabase();
});

afterAll(async () => {
	await teardownTestDatabase(db);
});

function buildEmdash() {
	const handleContentGet = vi.fn(async (_collection: string, _id: string, _locale?: string) => ({
		success: true as const,
		data: {
			item: {
				id: "resolved-id",
				type: "post",
				slug: "hello",
				status: "published",
				data: {},
				authorId: "u-edit",
				primaryBylineId: null,
				createdAt: "2026-01-01T00:00:00Z",
				updatedAt: "2026-01-01T00:00:00Z",
				publishedAt: "2026-01-01T00:00:00Z",
				scheduledAt: null,
				liveRevisionId: null,
				draftRevisionId: null,
				version: 1,
				locale: "en",
				translationGroup: "tg-1",
			},
			_rev: "rev1",
		},
	}));

	const handleContentUpdate = vi.fn(async () => ({
		success: true as const,
		data: { item: { id: "resolved-id" } },
	}));

	const handleContentDelete = vi.fn(async () => ({
		success: true as const,
		data: { deleted: true },
	}));

	const handleContentPublish = vi.fn(async () => ({
		success: true as const,
		data: { item: { id: "resolved-id" } },
	}));

	const handleContentUnpublish = vi.fn(async () => ({
		success: true as const,
		data: { item: { id: "resolved-id" } },
	}));

	const handleContentDiscardDraft = vi.fn(async () => ({
		success: true as const,
		data: { item: { id: "resolved-id" } },
	}));

	const handleContentSchedule = vi.fn(async () => ({
		success: true as const,
		data: { item: { id: "resolved-id" } },
	}));

	const handleContentUnschedule = vi.fn(async () => ({
		success: true as const,
		data: { item: { id: "resolved-id" } },
	}));

	return {
		db,
		handleContentGet,
		handleContentUpdate,
		handleContentDelete,
		handleContentPublish,
		handleContentUnpublish,
		handleContentDiscardDraft,
		handleContentSchedule,
		handleContentUnschedule,
	};
}

function ctx(opts: {
	user: typeof editor;
	emdash: ReturnType<typeof buildEmdash>;
	method?: string;
	body?: unknown;
	headers?: HeadersInit;
	url?: string;
}): APIContext {
	const url = new URL(opts.url ?? "http://localhost/_emdash/api/content/post/hello");
	const headers = new Headers(opts.headers);
	headers.set("content-type", "application/json");
	const request = new Request(url, {
		method: opts.method ?? "GET",
		headers,
		body: opts.body ? JSON.stringify(opts.body) : undefined,
	});
	return {
		params: { collection: "post", id: "hello" },
		url,
		request,
		locals: {
			user: opts.user,
			emdash: opts.emdash,
		},
		cache: { enabled: false, invalidate: vi.fn() },
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext;
}

function visualCtx(
	emdash: ReturnType<typeof buildEmdash>,
	path: string,
	token?: string,
): APIContext {
	return ctx({
		user: editor,
		emdash,
		method: "POST",
		headers: token ? { "X-EmDash-Visual-Action": token } : undefined,
		url: `http://localhost/_emdash/api/visual-editing/${path}`,
	});
}

describe("PUT /content/:collection/:id forwards locale to handleContentGet", () => {
	it("passes locale=en when query param is present", async () => {
		const emdash = buildEmdash();
		const res = await putItem(
			ctx({
				user: editor,
				emdash,
				method: "PUT",
				body: { data: { title: "Updated" } },
				url: "http://localhost/_emdash/api/content/post/hello?locale=en",
			}),
		);
		expect(res.status).toBe(200);
		expect(emdash.handleContentGet).toHaveBeenCalledWith("post", "hello", "en");
	});
});

describe("DELETE /content/:collection/:id forwards locale to handleContentGet", () => {
	it("passes locale=en when query param is present", async () => {
		const emdash = buildEmdash();
		const res = await deleteItem(
			ctx({
				user: editor,
				emdash,
				method: "DELETE",
				url: "http://localhost/_emdash/api/content/post/hello?locale=en",
			}),
		);
		expect(res.status).toBe(200);
		expect(emdash.handleContentGet).toHaveBeenCalledWith("post", "hello", "en");
	});
});

describe("POST /content/:collection/:id/publish forwards locale to handleContentGet", () => {
	it("passes locale=en when query param is present", async () => {
		const emdash = buildEmdash();
		const res = await postPublish(
			ctx({
				user: editor,
				emdash,
				method: "POST",
				url: "http://localhost/_emdash/api/content/post/hello/publish?locale=en",
			}),
		);
		expect(res.status).toBe(200);
		expect(emdash.handleContentGet).toHaveBeenCalledWith("post", "hello", "en");
		expect(emdash.handleContentPublish).toHaveBeenCalledWith(
			"post",
			"resolved-id",
			expect.objectContaining({
				actor: { id: editor.id, role: editor.role },
				origin: { source: "api" },
			}),
		);
	});

	it("does not trust a caller-controlled visual-editor header", async () => {
		const emdash = buildEmdash();
		const res = await postPublish(
			ctx({
				user: editor,
				emdash,
				method: "POST",
				headers: { "X-EmDash-Action-Origin": "visual-editor" },
				url: "http://localhost/_emdash/api/content/post/hello/publish",
			}),
		);
		expect(res.status).toBe(200);
		expect(emdash.handleContentPublish).toHaveBeenCalledWith(
			"post",
			"resolved-id",
			expect.objectContaining({ origin: { source: "api" } }),
		);
	});

	it("rejects the visual-editing route without server attestation", async () => {
		const emdash = buildEmdash();
		const res = await postVisualPublish(visualCtx(emdash, "content/post/hello/publish"));
		expect(res.status).toBe(403);
		await expect(res.json()).resolves.toMatchObject({
			error: { code: "VISUAL_ACTION_TOKEN_INVALID" },
		});
		expect(emdash.handleContentPublish).not.toHaveBeenCalled();
	});

	it("returns UNAUTHORIZED when visual publishing has no authenticated user", async () => {
		const emdash = buildEmdash();
		const context = visualCtx(emdash, "content/post/hello/publish");
		context.locals.user = null;

		const res = await postVisualPublish(context);

		expect(res.status).toBe(401);
		await expect(res.json()).resolves.toMatchObject({ error: { code: "UNAUTHORIZED" } });
		expect(emdash.handleContentPublish).not.toHaveBeenCalled();
	});

	it("marks publication with a short-lived token bound to the editor", async () => {
		const emdash = buildEmdash();
		const { previewSecret } = await resolveSecretsCached(db);
		const token = await generateVisualEditingActionToken(previewSecret, editor.id);
		const res = await postVisualPublish(visualCtx(emdash, "content/post/hello/publish", token));
		expect(res.status).toBe(200);
		expect(emdash.handleContentPublish).toHaveBeenCalledWith(
			"post",
			"resolved-id",
			expect.objectContaining({ origin: { source: "visual-editor" } }),
		);
	});

	it("renews a valid visual action token beyond its original lifetime", async () => {
		vi.useFakeTimers({ now: new Date("2030-01-01T00:00:00.000Z") });
		try {
			const emdash = buildEmdash();
			const { previewSecret } = await resolveSecretsCached(db);
			const originalToken = await generateVisualEditingActionToken(previewSecret, editor.id);
			vi.setSystemTime(new Date("2030-01-01T00:04:00.000Z"));
			const response = await refreshVisualActionToken(
				visualCtx(emdash, "action-token", originalToken),
			);
			expect(response.status).toBe(200);
			const body = await response.json();
			const renewedToken = body.data.token as string;

			vi.setSystemTime(new Date("2030-01-01T00:06:00.000Z"));
			await expect(
				verifyVisualEditingActionToken(originalToken, previewSecret, editor.id),
			).resolves.toBe(false);
			await expect(
				verifyVisualEditingActionToken(renewedToken, previewSecret, editor.id),
			).resolves.toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it.each([
		["missing", undefined],
		["invalid", "not-a-token"],
	])("rejects %s attestation when renewing a visual action token", async (_label, token) => {
		const emdash = buildEmdash();
		const response = await refreshVisualActionToken(visualCtx(emdash, "action-token", token));
		expect(response.status).toBe(403);
		await expect(response.json()).resolves.toMatchObject({
			error: { code: "VISUAL_ACTION_TOKEN_INVALID" },
		});
	});

	it("returns 422 for a policy rejection", async () => {
		const emdash = buildEmdash();
		emdash.handleContentPublish.mockResolvedValueOnce({
			success: false,
			error: { code: "PUBLISH_REJECTED", message: "Approval is required." },
		});

		const res = await postPublish(
			ctx({
				user: editor,
				emdash,
				method: "POST",
				url: "http://localhost/_emdash/api/content/post/hello/publish",
			}),
		);
		expect(res.status).toBe(422);
		await expect(res.json()).resolves.toMatchObject({
			error: { code: "PUBLISH_REJECTED", message: "Approval is required." },
		});
	});
});

describe("POST /content/:collection/:id/unpublish forwards locale to handleContentGet", () => {
	it("passes locale=en when query param is present", async () => {
		const emdash = buildEmdash();
		const res = await postUnpublish(
			ctx({
				user: editor,
				emdash,
				method: "POST",
				url: "http://localhost/_emdash/api/content/post/hello/unpublish?locale=en",
			}),
		);
		expect(res.status).toBe(200);
		expect(emdash.handleContentGet).toHaveBeenCalledWith("post", "hello", "en");
	});
});

describe("POST /content/:collection/:id/discard-draft forwards locale to handleContentGet", () => {
	it("passes locale=en when query param is present", async () => {
		const emdash = buildEmdash();
		const res = await postDiscard(
			ctx({
				user: editor,
				emdash,
				method: "POST",
				url: "http://localhost/_emdash/api/content/post/hello/discard-draft?locale=en",
			}),
		);
		expect(res.status).toBe(200);
		expect(emdash.handleContentGet).toHaveBeenCalledWith("post", "hello", "en");
	});
});

describe("POST /content/:collection/:id/schedule forwards locale to handleContentGet", () => {
	it("passes locale=en when query param is present", async () => {
		const emdash = buildEmdash();
		const res = await postSchedule(
			ctx({
				user: editor,
				emdash,
				method: "POST",
				body: { scheduledAt: "2026-12-31T23:59:59Z" },
				url: "http://localhost/_emdash/api/content/post/hello/schedule?locale=en",
			}),
		);
		expect(res.status).toBe(200);
		expect(emdash.handleContentGet).toHaveBeenCalledWith("post", "hello", "en");
	});
});

describe("DELETE /content/:collection/:id/schedule forwards locale to handleContentGet", () => {
	it("passes locale=en when query param is present", async () => {
		const emdash = buildEmdash();
		const res = await deleteSchedule(
			ctx({
				user: editor,
				emdash,
				method: "DELETE",
				url: "http://localhost/_emdash/api/content/post/hello/schedule?locale=en",
			}),
		);
		expect(res.status).toBe(200);
		expect(emdash.handleContentGet).toHaveBeenCalledWith("post", "hello", "en");
	});
});
