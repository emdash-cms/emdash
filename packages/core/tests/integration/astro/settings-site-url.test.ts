/**
 * GET/POST /_emdash/api/settings/site-url
 *
 * Exercises the dedicated `emdash:site_url` editor: validates input
 * normalization, scheme/origin restrictions, RBAC, and round-trip
 * persistence. See `packages/core/src/astro/routes/api/settings/site-url.ts`
 * and upstream issue #989 for why the `emdash:site_url` key is edited
 * via its own endpoint rather than through `POST /_emdash/api/settings`.
 */

import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	GET as getSiteUrl,
	POST as postSiteUrl,
} from "../../../src/astro/routes/api/settings/site-url.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const ADMIN_USER = { id: "user_admin", role: 50 as const };
const EDITOR_USER = { id: "user_editor", role: 40 as const };

function buildRequest(body: unknown): Request {
	return new Request("http://localhost/_emdash/api/settings/site-url", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
}

function buildContext(
	db: Kysely<Database>,
	request: Request | null,
	user: { id: string; role: 10 | 20 | 30 | 40 | 50 } | null,
): APIContext {
	return {
		params: {},
		url: new URL(request?.url ?? "http://localhost/_emdash/api/settings/site-url"),
		request: request ?? new Request("http://localhost/_emdash/api/settings/site-url"),
		locals: {
			emdash: {
				db,
				config: {},
				storage: undefined,
			},
			user,
		},
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- minimal stub
	} as unknown as APIContext;
}

describe("GET /_emdash/api/settings/site-url", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("returns the stored site_url", async () => {
		const options = new OptionsRepository(db);
		await options.set("emdash:site_url", "https://stored.example");

		const res = await getSiteUrl(buildContext(db, null, ADMIN_USER));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: { siteUrl: string | null } };
		expect(body.data.siteUrl).toBe("https://stored.example");
	});

	it("returns null when the option has never been set", async () => {
		const res = await getSiteUrl(buildContext(db, null, ADMIN_USER));
		expect(res.status).toBe(200);
		const body = (await res.json()) as { data: { siteUrl: string | null } };
		expect(body.data.siteUrl).toBeNull();
	});

	it("requires an authenticated user", async () => {
		const res = await getSiteUrl(buildContext(db, null, null));
		expect(res.status).toBe(401);
	});
});

describe("POST /_emdash/api/settings/site-url", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("stores a normalized origin", async () => {
		const res = await postSiteUrl(
			buildContext(db, buildRequest({ siteUrl: "https://new.example" }), ADMIN_USER),
		);
		expect(res.status).toBe(200);

		const options = new OptionsRepository(db);
		expect(await options.get("emdash:site_url")).toBe("https://new.example");
	});

	it("strips a trailing slash before persisting", async () => {
		// Address-bar paste commonly includes a trailing slash. The URL
		// constructor preserves the path; we explicitly normalize to `origin`.
		const res = await postSiteUrl(
			buildContext(db, buildRequest({ siteUrl: "https://new.example/" }), ADMIN_USER),
		);
		expect(res.status).toBe(200);

		const options = new OptionsRepository(db);
		expect(await options.get("emdash:site_url")).toBe("https://new.example");
	});

	it("overwrites a previously-stored value", async () => {
		// The setup wizard uses setIfAbsent() which would refuse to overwrite.
		// The admin endpoint must use plain set() so post-setup edits succeed.
		const options = new OptionsRepository(db);
		await options.set("emdash:site_url", "https://old.example");

		const res = await postSiteUrl(
			buildContext(db, buildRequest({ siteUrl: "https://new.example" }), ADMIN_USER),
		);
		expect(res.status).toBe(200);

		expect(await options.get("emdash:site_url")).toBe("https://new.example");
	});

	it("rejects non-http(s) schemes", async () => {
		// XSS-vector schemes must never be writable here -- this value gets
		// interpolated into outgoing email content.
		const res = await postSiteUrl(
			buildContext(
				db,
				buildRequest({ siteUrl: "javascript:alert(1)" }),
				ADMIN_USER,
			),
		);
		expect(res.status).toBe(400);

		const options = new OptionsRepository(db);
		expect(await options.get("emdash:site_url")).toBeNull();
	});

	it("rejects values that include a path component", async () => {
		// The stored value is an origin only -- `getSiteBaseUrl()` appends
		// `/_emdash` on read. A pre-pended path would produce double-pathed
		// links in transactional emails.
		const res = await postSiteUrl(
			buildContext(
				db,
				buildRequest({ siteUrl: "https://example.com/admin" }),
				ADMIN_USER,
			),
		);
		expect(res.status).toBe(400);
	});

	it("rejects values that include a query string", async () => {
		const res = await postSiteUrl(
			buildContext(
				db,
				buildRequest({ siteUrl: "https://example.com?x=1" }),
				ADMIN_USER,
			),
		);
		expect(res.status).toBe(400);
	});

	it("rejects unparseable URLs", async () => {
		const res = await postSiteUrl(
			buildContext(db, buildRequest({ siteUrl: "not a url" }), ADMIN_USER),
		);
		expect(res.status).toBe(400);
	});

	it("rejects callers without settings:manage", async () => {
		// Editors have settings:read but not settings:manage.
		const res = await postSiteUrl(
			buildContext(
				db,
				buildRequest({ siteUrl: "https://new.example" }),
				EDITOR_USER,
			),
		);
		expect(res.status).toBe(403);
	});

	it("requires an authenticated user", async () => {
		const res = await postSiteUrl(
			buildContext(db, buildRequest({ siteUrl: "https://new.example" }), null),
		);
		expect(res.status).toBe(401);
	});
});
