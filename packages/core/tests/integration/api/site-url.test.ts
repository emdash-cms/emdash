import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getPublicOrigin } from "../../../src/api/public-url.js";
import { getSiteBaseUrl } from "../../../src/api/site-url.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { SiteSettingsRepository } from "../../../src/database/repositories/site-settings.js";
import type { Database } from "../../../src/database/types.js";
import { runWithContext } from "../../../src/request-context.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const REQUEST_URL = "https://real.example/_emdash/api/auth/magic-link/send";
const asSite = <T>(siteId: string, fn: () => T): T =>
	runWithContext({ editMode: false, siteId }, fn);

describe("getSiteBaseUrl", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("uses each site's stored URL even when the request host names another site", async () => {
		await asSite("foo", () => new SiteSettingsRepository(db).set("url", "https://foo.example"));
		await asSite("bar", () => new SiteSettingsRepository(db).set("url", "https://bar.example"));
		const request = new Request(REQUEST_URL, { method: "POST" });
		expect(await asSite("foo", () => getSiteBaseUrl(db, request))).toBe(
			"https://foo.example/_emdash",
		);
		expect(await asSite("bar", () => getSiteBaseUrl(db, request))).toBe(
			"https://bar.example/_emdash",
		);
	});

	it("uses the configured origin ahead of the site's stored URL", async () => {
		await asSite("foo", () => new SiteSettingsRepository(db).set("url", "https://foo.example"));
		const request = new Request(REQUEST_URL, { method: "POST" });
		const config = { siteUrl: "https://configured.example" };
		expect(getPublicOrigin(new URL(request.url), config)).toBe("https://configured.example");
		expect(await asSite("foo", () => getSiteBaseUrl(db, request, config))).toBe(
			"https://configured.example/_emdash",
		);
	});

	it("does not use the legacy setup URL as public identity", async () => {
		await new OptionsRepository(db).set("emdash:site_url", "https://old.example");
		const request = new Request(REQUEST_URL, { method: "POST" });
		expect(await asSite("foo", () => getSiteBaseUrl(db, request))).toBe(
			"https://real.example/_emdash",
		);
	});

	it("rejects an unselected site even when a configured origin is available", async () => {
		await expect(
			getSiteBaseUrl(db, new Request(REQUEST_URL), { siteUrl: "https://foo.example" }),
		).rejects.toThrow("server-selected site");
	});

	it("rejects invalid stored origins and accepts HTTP only for loopback", async () => {
		const request = new Request(REQUEST_URL);
		await asSite("foo", () => new SiteSettingsRepository(db).set("url", "ftp://foo.example"));
		expect(await asSite("foo", () => getSiteBaseUrl(db, request))).toBe(
			"https://real.example/_emdash",
		);
		await asSite("foo", () => new SiteSettingsRepository(db).set("url", "http://localhost:4321"));
		expect(await asSite("foo", () => getSiteBaseUrl(db, request))).toBe(
			"http://localhost:4321/_emdash",
		);
	});
});
