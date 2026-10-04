import type { APIContext } from "astro";
import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { handleSiteDomainChange, parseSiteDomain } from "../../../src/api/handlers/site-domain.js";
import { _resetEnvCache } from "../../../src/api/public-url.js";
import { getSiteBaseUrl } from "../../../src/api/site-url.js";
import { POST as postDomainProof } from "../../../src/astro/routes/api/site/domain-proof.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { setDefaultDnsResolver } from "../../../src/security/ssrf.js";
import { getSiteSettingsWithDb, setSiteSettings } from "../../../src/settings/index.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

let previousResolver: ReturnType<typeof setDefaultDnsResolver> | undefined;
beforeAll(() => {
	previousResolver = setDefaultDnsResolver(async () => ["93.184.216.34"]);
});
afterAll(() => {
	setDefaultDnsResolver(previousResolver ?? null);
});

/** Routes requests for `host` to the domain-proof endpoint of the site backed by `siteDb`. */
function serveSite(host: string, siteDb: Kysely<Database>) {
	vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
		const url = new URL(input instanceof Request ? input.url : input);
		if (url.host !== host) throw new TypeError("fetch failed");
		if (url.pathname !== "/_emdash/api/site/domain-proof" || init?.method !== "POST") {
			return new Response(null, { status: 404 });
		}
		return postDomainProof({ locals: { emdash: { db: siteDb } } } as unknown as APIContext);
	});
}

describe("changing the site domain", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		vi.stubEnv("EMDASH_SITE_URL", "");
		vi.stubEnv("SITE_URL", "");
		_resetEnvCache();
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		_resetEnvCache();
		await teardownTestDatabase(db);
	});

	it("stores a domain that serves this site as the Site URL", async () => {
		serveSite("new.example", db);

		const result = await handleSiteDomainChange(db, "new.example");

		expect(result).toEqual({ success: true, data: { url: "https://new.example" } });
		expect((await getSiteSettingsWithDb(db)).url).toBe("https://new.example");
		expect(await getSiteBaseUrl(db, new Request("https://old.example/"))).toBe(
			"https://new.example/_emdash",
		);
	});

	it("does not store a domain that serves a different site", async () => {
		await setSiteSettings({ url: "https://old.example" }, db);
		vi.stubGlobal("fetch", async () => Response.json({ data: { token: "another-sites-token" } }));

		const result = await handleSiteDomainChange(db, "https://new.example");

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("DOMAIN_CHECK_FAILED");
		expect((await getSiteSettingsWithDb(db)).url).toBe("https://old.example");
	});

	it("names the target when the domain redirects", async () => {
		vi.stubGlobal(
			"fetch",
			async () =>
				new Response(null, {
					status: 301,
					headers: { Location: "https://www.new.example/_emdash/api/site/domain-proof" },
				}),
		);

		const result = await handleSiteDomainChange(db, "new.example");

		expect(result.success).toBe(false);
		if (!result.success) {
			expect(result.error.code).toBe("DOMAIN_CHECK_FAILED");
			expect(result.error.message).toContain("https://www.new.example");
		}
		expect((await getSiteSettingsWithDb(db)).url).toBeUndefined();
	});

	it("reports an unreachable domain", async () => {
		serveSite("elsewhere.example", db);

		const result = await handleSiteDomainChange(db, "new.example");

		expect(result.success).toBe(false);
		if (!result.success) expect(result.error.code).toBe("DOMAIN_CHECK_FAILED");
	});

	it("leaves the token of a check that started later in place", async () => {
		vi.stubGlobal("fetch", async () => {
			await new OptionsRepository(db).set("emdash:domain_proof", {
				token: "later-check",
				expiresAt: Date.now() + 60_000,
			});
			return Response.json({ data: { token: "later-check" } });
		});

		await handleSiteDomainChange(db, "new.example");

		const response = await postDomainProof({
			locals: { emdash: { db } },
		} as unknown as APIContext);
		expect(await response.json()).toMatchObject({ data: { token: "later-check" } });
	});

	it("serves no proof outside a check", async () => {
		serveSite("new.example", db);
		await handleSiteDomainChange(db, "new.example");

		const response = await postDomainProof({
			locals: { emdash: { db } },
		} as unknown as APIContext);

		expect(response.status).toBe(404);
	});
});

describe("parseSiteDomain", () => {
	it.each([
		["example.com", "https://example.com"],
		["  Blog.Example.com ", "https://blog.example.com"],
		["https://example.com/", "https://example.com"],
	])("accepts %j", (input, origin) => {
		expect(parseSiteDomain(input)).toBe(origin);
	});

	it.each([
		"http://example.com",
		"https://example.com/blog",
		"example.com:8443",
		"user@example.com",
		"localhost",
		"192.0.2.10",
		"[2001:db8::1]",
		"example.com.",
	])("rejects %j", (input) => {
		expect(parseSiteDomain(input)).toBeUndefined();
	});
});
