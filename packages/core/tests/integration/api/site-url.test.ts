/**
 * getSiteBaseUrl precedence: configured origin → stored setup origin →
 * request URL. The configured origin is what `siteUrl` in the integration
 * options resolves to; the stored `emdash:site_url` option is written once
 * during setup; the request URL only fills in before setup completes and
 * must never override either of the other two (Host-spoofing lock).
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getPublicOrigin } from "../../../src/api/public-url.js";
import { getSiteBaseUrl } from "../../../src/api/site-url.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const SETUP_ORIGIN = "https://my-site.workers.dev";
const REAL_ORIGIN = "https://real.example";
const REQUEST_URL = `${REAL_ORIGIN}/_emdash/api/auth/magic-link/send`;

describe("getSiteBaseUrl", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("configured siteUrl beats the stored setup origin", async () => {
		// Setup ran on a throwaway origin; the operator has since configured
		// the real one. Email links must follow the config, like every other
		// origin-dependent feature does via getPublicOrigin.
		await new OptionsRepository(db).set("emdash:site_url", SETUP_ORIGIN);
		const config = { siteUrl: REAL_ORIGIN };
		const request = new Request(REQUEST_URL, { method: "POST" });

		expect(getPublicOrigin(new URL(request.url), config)).toBe(REAL_ORIGIN);
		expect(await getSiteBaseUrl(db, request, config)).toBe(`${REAL_ORIGIN}/_emdash`);
	});

	it("falls back to the stored setup origin when nothing is configured", async () => {
		await new OptionsRepository(db).set("emdash:site_url", SETUP_ORIGIN);
		const request = new Request(REQUEST_URL, { method: "POST" });

		expect(await getSiteBaseUrl(db, request)).toBe(`${SETUP_ORIGIN}/_emdash`);
	});

	it("stored origin is not overridden by the request host", async () => {
		// The Host-spoofing lock: a stored value always beats the request.
		await new OptionsRepository(db).set("emdash:site_url", SETUP_ORIGIN);
		const spoofed = new Request("https://attacker.example/_emdash/api/auth/magic-link/send", {
			method: "POST",
		});

		expect(await getSiteBaseUrl(db, spoofed)).toBe(`${SETUP_ORIGIN}/_emdash`);
	});

	it("derives from the request only before setup has stored an origin", async () => {
		const request = new Request(REQUEST_URL, { method: "POST" });

		expect(await getSiteBaseUrl(db, request)).toBe(`${REAL_ORIGIN}/_emdash`);
	});
});
