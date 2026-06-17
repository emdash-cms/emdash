/**
 * Content route locale forwarding.
 *
 * When a ?locale query param is present, single-item write routes must
 * forward it to handleContentGet so slug-based lookups resolve to the
 * correct i18n variant instead of returning the first matching row.
 */

import { Role } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { describe, it, expect, vi } from "vitest";

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

const editor = { id: "u-edit", role: Role.EDITOR };

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
	url?: string;
}): APIContext {
	const url = new URL(opts.url ?? "http://localhost/_emdash/api/content/post/hello");
	const request = new Request(url, {
		method: opts.method ?? "GET",
		headers: { "content-type": "application/json" },
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
