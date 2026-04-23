/**
 * Content read endpoint authorization.
 *
 * content:read is granted to SUBSCRIBER so member-only published content can
 * be read via the admin API. Drafts, scheduled, trashed items, and editor
 * views (revisions, compare, preview-url) are gated on content:read_drafts
 * (CONTRIBUTOR+):
 *
 *   - GET /content/:c forces status=published for SUBSCRIBER, ignoring any
 *     caller-supplied status filter.
 *   - GET /content/:c/:id returns 404 to SUBSCRIBER for non-published items
 *     (404 to avoid leaking existence via status code).
 *   - /compare, /revisions, /trash, /preview-url require content:read_drafts.
 *   - /translations filters non-published locales out for SUBSCRIBER.
 */

import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext } from "astro";
import { describe, it, expect, vi } from "vitest";

import { GET as getItem } from "../../../src/astro/routes/api/content/[collection]/[id].js";
import { GET as getCompare } from "../../../src/astro/routes/api/content/[collection]/[id]/compare.js";
import { POST as postPreviewUrl } from "../../../src/astro/routes/api/content/[collection]/[id]/preview-url.js";
import { GET as getRevisions } from "../../../src/astro/routes/api/content/[collection]/[id]/revisions.js";
import { GET as getTranslations } from "../../../src/astro/routes/api/content/[collection]/[id]/translations.js";
import { GET as getList } from "../../../src/astro/routes/api/content/[collection]/index.js";
import { GET as getTrash } from "../../../src/astro/routes/api/content/[collection]/trash.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface StubUser {
	id: string;
	role: RoleLevel;
}

const subscriber: StubUser = { id: "u-sub", role: Role.SUBSCRIBER };
const contributor: StubUser = { id: "u-con", role: Role.CONTRIBUTOR };
const editor: StubUser = { id: "u-edit", role: Role.EDITOR };

interface StubItem {
	id: string;
	type: string;
	slug: string | null;
	status: string;
	data: Record<string, unknown>;
	authorId: string | null;
	primaryBylineId: string | null;
	createdAt: string;
	updatedAt: string;
	publishedAt: string | null;
	scheduledAt: string | null;
	liveRevisionId: string | null;
	draftRevisionId: string | null;
	version: number;
	locale: string | null;
	translationGroup: string | null;
}

function makeItem(partial: Partial<StubItem> & { id: string; status: string }): StubItem {
	return {
		type: "post",
		slug: partial.id,
		data: {},
		authorId: null,
		primaryBylineId: null,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		publishedAt: partial.status === "published" ? "2026-01-01T00:00:00Z" : null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
		version: 1,
		locale: null,
		translationGroup: null,
		...partial,
	};
}

function buildEmdash(
	opts: {
		listItems?: StubItem[];
		getItem?: StubItem | null;
		translations?: Array<{
			id: string;
			status: string;
			locale: string | null;
			slug: string | null;
			updatedAt: string;
		}>;
		trashItems?: StubItem[];
		revisions?: Array<{ id: string }>;
		compare?: { hasChanges: boolean; live: unknown; draft: unknown };
	} = {},
) {
	const handleContentList = vi.fn(async (_collection: string, params: { status?: string }) => {
		const items = params.status
			? (opts.listItems ?? []).filter((i) => i.status === params.status)
			: (opts.listItems ?? []);
		return { success: true as const, data: { items, nextCursor: undefined } };
	});

	const handleContentGet = vi.fn(async (_collection: string, _id: string) => {
		if (!opts.getItem) {
			return { success: false as const, error: { code: "NOT_FOUND", message: "not found" } };
		}
		return { success: true as const, data: { item: opts.getItem, _rev: "rev1" } };
	});

	const handleContentTranslations = vi.fn(async () => ({
		success: true as const,
		data: { translationGroup: "tg-1", translations: opts.translations ?? [] },
	}));

	const handleContentListTrashed = vi.fn(async () => ({
		success: true as const,
		data: { items: opts.trashItems ?? [], nextCursor: undefined },
	}));

	const handleRevisionList = vi.fn(async () => ({
		success: true as const,
		data: { items: opts.revisions ?? [] },
	}));

	const handleContentCompare = vi.fn(async () => ({
		success: true as const,
		data: opts.compare ?? { hasChanges: false, live: null, draft: null },
	}));

	return {
		handleContentList,
		handleContentGet,
		handleContentTranslations,
		handleContentListTrashed,
		handleRevisionList,
		handleContentCompare,
	};
}

function ctx(opts: {
	user: StubUser | null;
	emdash: ReturnType<typeof buildEmdash>;
	params?: Record<string, string>;
	url?: string;
	request?: Request;
}): APIContext {
	const url = new URL(opts.url ?? "http://localhost/");
	return {
		params: opts.params ?? { collection: "post" },
		url,
		request: opts.request ?? new Request(url),
		locals: {
			user: opts.user,
			emdash: opts.emdash,
		},
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- minimal stub for tests
	} as unknown as APIContext;
}

// ---------------------------------------------------------------------------
// LIST endpoint
// ---------------------------------------------------------------------------

describe("GET /content/:collection — subscriber drafts leak", () => {
	const items = [
		makeItem({ id: "draft-1", status: "draft" }),
		makeItem({ id: "pub-1", status: "published" }),
		makeItem({ id: "sched-1", status: "scheduled" }),
	];

	it("forces status=published filter for SUBSCRIBER", async () => {
		const emdash = buildEmdash({ listItems: items });
		const res = await getList(ctx({ user: subscriber, emdash }));
		expect(res.status).toBe(200);
		expect(emdash.handleContentList).toHaveBeenCalledWith(
			"post",
			expect.objectContaining({ status: "published" }),
		);
		const body = (await res.json()) as { data: { items: StubItem[] } };
		expect(body.data.items.map((i) => i.id)).toEqual(["pub-1"]);
	});

	it("rejects subscriber attempt to override status filter to draft", async () => {
		const emdash = buildEmdash({ listItems: items });
		const res = await getList(
			ctx({
				user: subscriber,
				emdash,
				url: "http://localhost/?status=draft",
			}),
		);
		expect(res.status).toBe(200);
		// The route must not honour ?status=draft for SUBSCRIBER — should still
		// be forced to published.
		expect(emdash.handleContentList).toHaveBeenCalledWith(
			"post",
			expect.objectContaining({ status: "published" }),
		);
		const body = (await res.json()) as { data: { items: StubItem[] } };
		expect(body.data.items.every((i) => i.status === "published")).toBe(true);
	});

	it("returns full set for CONTRIBUTOR (has read_drafts)", async () => {
		const emdash = buildEmdash({ listItems: items });
		const res = await getList(ctx({ user: contributor, emdash }));
		expect(res.status).toBe(200);
		// status param is undefined (caller-controlled), not forced
		const call = emdash.handleContentList.mock.calls[0]?.[1];
		expect(call?.status).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// GET single item
// ---------------------------------------------------------------------------

describe("GET /content/:collection/:id — subscriber drafts leak", () => {
	it("returns 404 to SUBSCRIBER fetching a draft", async () => {
		const emdash = buildEmdash({ getItem: makeItem({ id: "p1", status: "draft" }) });
		const res = await getItem(
			ctx({ user: subscriber, emdash, params: { collection: "post", id: "p1" } }),
		);
		expect(res.status).toBe(404);
	});

	it("returns 404 to SUBSCRIBER fetching a scheduled item", async () => {
		const emdash = buildEmdash({ getItem: makeItem({ id: "p1", status: "scheduled" }) });
		const res = await getItem(
			ctx({ user: subscriber, emdash, params: { collection: "post", id: "p1" } }),
		);
		expect(res.status).toBe(404);
	});

	it("allows SUBSCRIBER to fetch a published item", async () => {
		const emdash = buildEmdash({ getItem: makeItem({ id: "p1", status: "published" }) });
		const res = await getItem(
			ctx({ user: subscriber, emdash, params: { collection: "post", id: "p1" } }),
		);
		expect(res.status).toBe(200);
	});

	it("allows CONTRIBUTOR to fetch a draft", async () => {
		const emdash = buildEmdash({ getItem: makeItem({ id: "p1", status: "draft" }) });
		const res = await getItem(
			ctx({ user: contributor, emdash, params: { collection: "post", id: "p1" } }),
		);
		expect(res.status).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// Editor-only views — must require content:read_drafts
// ---------------------------------------------------------------------------

describe("editor-only content views require content:read_drafts", () => {
	it("denies SUBSCRIBER on /compare", async () => {
		const emdash = buildEmdash({ compare: { hasChanges: false, live: null, draft: null } });
		const res = await getCompare(
			ctx({ user: subscriber, emdash, params: { collection: "post", id: "p1" } }),
		);
		expect(res.status).toBe(403);
		expect(emdash.handleContentCompare).not.toHaveBeenCalled();
	});

	it("allows CONTRIBUTOR on /compare", async () => {
		const emdash = buildEmdash({ compare: { hasChanges: false, live: null, draft: null } });
		const res = await getCompare(
			ctx({ user: contributor, emdash, params: { collection: "post", id: "p1" } }),
		);
		expect(res.status).toBe(200);
	});

	it("denies SUBSCRIBER on /revisions", async () => {
		const emdash = buildEmdash({ revisions: [] });
		const res = await getRevisions(
			ctx({ user: subscriber, emdash, params: { collection: "post", id: "p1" } }),
		);
		expect(res.status).toBe(403);
		expect(emdash.handleRevisionList).not.toHaveBeenCalled();
	});

	it("denies SUBSCRIBER on /trash", async () => {
		const emdash = buildEmdash({ trashItems: [] });
		const res = await getTrash(ctx({ user: subscriber, emdash }));
		expect(res.status).toBe(403);
		expect(emdash.handleContentListTrashed).not.toHaveBeenCalled();
	});

	it("denies SUBSCRIBER on /preview-url POST", async () => {
		const emdash = buildEmdash({ getItem: makeItem({ id: "p1", status: "published" }) });
		const url = "http://localhost/";
		const res = await postPreviewUrl(
			ctx({
				user: subscriber,
				emdash,
				params: { collection: "post", id: "p1" },
				url,
				request: new Request(url, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: "{}",
				}),
			}),
		);
		expect(res.status).toBe(403);
		expect(emdash.handleContentGet).not.toHaveBeenCalled();
	});

	it("allows EDITOR on /trash", async () => {
		const emdash = buildEmdash({ trashItems: [] });
		const res = await getTrash(ctx({ user: editor, emdash }));
		expect(res.status).toBe(200);
	});
});

// ---------------------------------------------------------------------------
// Translations endpoint — must status-filter for SUBSCRIBER
// ---------------------------------------------------------------------------

describe("GET /content/:collection/:id/translations", () => {
	const translations = [
		{
			id: "t-en",
			locale: "en",
			slug: "p1",
			status: "published",
			updatedAt: "2026-01-01T00:00:00Z",
		},
		{ id: "t-fr", locale: "fr", slug: "p1", status: "draft", updatedAt: "2026-01-01T00:00:00Z" },
		{
			id: "t-de",
			locale: "de",
			slug: "p1",
			status: "scheduled",
			updatedAt: "2026-01-01T00:00:00Z",
		},
	];

	it("filters non-published translations for SUBSCRIBER", async () => {
		const emdash = buildEmdash({ translations });
		const res = await getTranslations(
			ctx({ user: subscriber, emdash, params: { collection: "post", id: "p1" } }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			data: { translations: Array<{ id: string; status: string }> };
		};
		expect(body.data.translations.map((t) => t.id)).toEqual(["t-en"]);
	});

	it("returns all translations for CONTRIBUTOR", async () => {
		const emdash = buildEmdash({ translations });
		const res = await getTranslations(
			ctx({ user: contributor, emdash, params: { collection: "post", id: "p1" } }),
		);
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			data: { translations: Array<{ id: string; status: string }> };
		};
		expect(body.data.translations).toHaveLength(3);
	});
});
