/**
 * getEmailLocale: locale priority for outbound system emails (#915).
 *
 * Priority: site-wide `emdash:locale` option -> requester's admin
 * locale (emdash-locale cookie, then Accept-Language) -> English.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getEmailLocale } from "../../../src/api/email-locale.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function request(headers: Record<string, string> = {}): Request {
	return new Request("http://test.local/_emdash/api/auth/invite", { headers });
}

describe("getEmailLocale (#915)", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("prefers the site-wide emdash:locale option over request headers", async () => {
		await new OptionsRepository(db).set("emdash:locale", "de");

		const locale = await getEmailLocale(
			db,
			request({ cookie: "emdash-locale=fr", "accept-language": "es" }),
		);

		expect(locale).toBe("de");
	});

	it("falls back to the requester's cookie locale when no site locale is set", async () => {
		const locale = await getEmailLocale(
			db,
			request({ cookie: "emdash-locale=fr", "accept-language": "es" }),
		);

		expect(locale).toBe("fr");
	});

	it("falls back to Accept-Language when neither site locale nor cookie exist", async () => {
		const locale = await getEmailLocale(db, request({ "accept-language": "es-ES,es;q=0.9" }));

		expect(locale).toBe("es-ES");
	});

	it("defaults to English with no signals at all", async () => {
		const locale = await getEmailLocale(db, request());

		expect(locale).toBe("en");
	});

	it("ignores an unsupported cookie locale and keeps resolving", async () => {
		const locale = await getEmailLocale(
			db,
			request({ cookie: "emdash-locale=xx", "accept-language": "ja" }),
		);

		expect(locale).toBe("ja");
	});
});
