/**
 * Single-entry write routes resolve the entry to check ownership. A role that
 * can never perform the action is refused before that lookup, so it gets the
 * same 403 whether or not the entry exists, matching GET's 404 for
 * non-published entries.
 */

import { Role, type RoleLevel } from "@emdash-cms/auth";
import type { APIContext, APIRoute } from "astro";
import { describe, it, expect, vi } from "vitest";

import {
	DELETE as deleteItem,
	PUT as putItem,
} from "../../../src/astro/routes/api/content/[collection]/[id].js";
import { POST as postDiscardDraft } from "../../../src/astro/routes/api/content/[collection]/[id]/discard-draft.js";
import {
	DELETE as deleteLock,
	GET as getLock,
	POST as postLock,
} from "../../../src/astro/routes/api/content/[collection]/[id]/lock.js";
import { POST as postPublish } from "../../../src/astro/routes/api/content/[collection]/[id]/publish.js";
import { POST as postRestore } from "../../../src/astro/routes/api/content/[collection]/[id]/restore.js";
import {
	DELETE as deleteSchedule,
	POST as postSchedule,
} from "../../../src/astro/routes/api/content/[collection]/[id]/schedule.js";
import { POST as postUnpublish } from "../../../src/astro/routes/api/content/[collection]/[id]/unpublish.js";
import { POST as postRevisionRestore } from "../../../src/astro/routes/api/revisions/[revisionId]/restore.js";

interface StubUser {
	id: string;
	role: RoleLevel;
}

const subscriber: StubUser = { id: "u-sub", role: Role.SUBSCRIBER };
const contributor: StubUser = { id: "u-con", role: Role.CONTRIBUTOR };
const author: StubUser = { id: "u-auth", role: Role.AUTHOR };

const notFound = {
	success: false as const,
	error: { code: "NOT_FOUND", message: "Content item not found" },
};

/**
 * A runtime whose lookups answer for another author's draft, or NOT_FOUND when
 * `exists` is false. The write handlers are present so the routes get past
 * their NOT_CONFIGURED guard, and must never run.
 */
function buildEmdash(exists: boolean) {
	const entry = {
		success: true as const,
		data: { item: { id: "p1", slug: "p1", status: "draft", authorId: "u-other" }, _rev: "rev1" },
	};
	const revision = {
		success: true as const,
		data: { item: { id: "r1", collection: "post", entryId: "p1" } },
	};
	const lookup = vi.fn(async () => (exists ? entry : notFound));
	const revisionLookup = vi.fn(async () => (exists ? revision : notFound));
	const write = vi.fn(async () => ({ success: true as const, data: {} }));
	return {
		lookup,
		revisionLookup,
		write,
		emdash: {
			db: {},
			handleContentGet: lookup,
			handleContentGetIncludingTrashed: lookup,
			handleRevisionGet: revisionLookup,
			handleContentUpdate: write,
			handleContentDelete: write,
			handleContentDiscardDraft: write,
			handleContentPublish: write,
			handleContentUnpublish: write,
			handleContentSchedule: write,
			handleContentUnschedule: write,
			handleContentRestore: write,
			handleRevisionRestore: write,
		},
	};
}

function ctx(
	user: StubUser,
	emdash: ReturnType<typeof buildEmdash>["emdash"],
	method: string,
	body?: unknown,
): APIContext {
	const url = new URL("http://localhost/_emdash/api/content/post/p1");
	return {
		params: { collection: "post", id: "p1", revisionId: "r1" },
		url,
		request: new Request(url, {
			method,
			headers: { "Content-Type": "application/json" },
			...(body === undefined ? {} : { body: JSON.stringify(body) }),
		}),
		locals: { user, emdash },
		cache: { enabled: false, invalidate: vi.fn() },
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal stub for tests
	} as unknown as APIContext;
}

const routes: Array<[name: string, handler: APIRoute, method: string, body?: unknown]> = [
	["PUT /content/:collection/:id", putItem, "PUT", { data: {} }],
	["DELETE /content/:collection/:id", deleteItem, "DELETE"],
	["POST …/:id/discard-draft", postDiscardDraft, "POST"],
	["GET …/:id/lock", getLock, "GET"],
	["POST …/:id/lock", postLock, "POST"],
	["DELETE …/:id/lock", deleteLock, "DELETE"],
	["POST …/:id/publish", postPublish, "POST"],
	["POST …/:id/unpublish", postUnpublish, "POST"],
	["POST …/:id/schedule", postSchedule, "POST", { scheduledAt: "2030-01-01T00:00:00.000Z" }],
	["DELETE …/:id/schedule", deleteSchedule, "DELETE"],
	["POST …/:id/restore", postRestore, "POST"],
	["POST /revisions/:revisionId/restore", postRevisionRestore, "POST"],
];

describe("single-entry write routes check the role before the lookup", () => {
	it.each(routes)(
		"%s answers SUBSCRIBER 403 without looking the entry up",
		async (_name, handler, method, body) => {
			for (const exists of [false, true]) {
				const { emdash, lookup, revisionLookup, write } = buildEmdash(exists);
				const res = await handler(ctx(subscriber, emdash, method, body));
				expect(res.status).toBe(403);
				const json = (await res.json()) as { error: { code: string } };
				expect(json.error.code).toBe("FORBIDDEN");
				expect(lookup).not.toHaveBeenCalled();
				expect(revisionLookup).not.toHaveBeenCalled();
				expect(write).not.toHaveBeenCalled();
			}
		},
	);

	// The draft-only edit grant starts at CONTRIBUTOR, so PUT and the lock
	// routes must still resolve the entry for them; the other actions need
	// AUTHOR and are refused up front.
	it("still resolves the entry for CONTRIBUTOR on PUT and lock", async () => {
		for (const [handler, method, body] of [
			[putItem, "PUT", { data: {} }],
			[getLock, "GET", undefined],
		] as const) {
			const { emdash, lookup } = buildEmdash(false);
			const res = await handler(ctx(contributor, emdash, method, body));
			expect(res.status).toBe(404);
			expect(lookup).toHaveBeenCalledOnce();
		}
	});

	it("refuses CONTRIBUTOR before the lookup on routes that need AUTHOR", async () => {
		const { emdash, lookup } = buildEmdash(false);
		const res = await deleteItem(ctx(contributor, emdash, "DELETE"));
		expect(res.status).toBe(403);
		expect(lookup).not.toHaveBeenCalled();
	});

	it.each(routes)(
		"%s still answers AUTHOR 404 for a missing entry",
		async (_name, handler, method, body) => {
			const { emdash, write } = buildEmdash(false);
			const res = await handler(ctx(author, emdash, method, body));
			expect(res.status).toBe(404);
			expect(write).not.toHaveBeenCalled();
		},
	);

	it.each(routes)(
		"%s still answers AUTHOR 403 for another author's entry",
		async (_name, handler, method, body) => {
			const { emdash, write } = buildEmdash(true);
			const res = await handler(ctx(author, emdash, method, body));
			expect(res.status).toBe(403);
			expect(write).not.toHaveBeenCalled();
		},
	);
});
