/**
 * resolveEmailLocale: locale priority for outbound system emails.
 *
 * Priority: site-wide `emdash:locale` option -> requester's admin
 * locale (emdash-locale cookie, then Accept-Language) -> English.
 */

import { describe, expect, it } from "vitest";

import { resolveEmailLocale } from "../../../src/api/email-locale.js";

function request(headers: Record<string, string> = {}): Request {
	return new Request("http://test.local/_emdash/api/auth/invite", { headers });
}

describe("resolveEmailLocale", () => {
	it("prefers the site locale over request headers", () => {
		const locale = resolveEmailLocale(
			"de",
			request({ cookie: "emdash-locale=fr", "accept-language": "es" }),
		);

		expect(locale).toBe("de");
	});

	it("falls back to the requester's cookie locale when no site locale is set", () => {
		const locale = resolveEmailLocale(
			null,
			request({ cookie: "emdash-locale=fr", "accept-language": "es" }),
		);

		expect(locale).toBe("fr");
	});

	it("falls back to Accept-Language when neither site locale nor cookie exist", () => {
		const locale = resolveEmailLocale(undefined, request({ "accept-language": "es-ES,es;q=0.9" }));

		expect(locale).toBe("es-ES");
	});

	it("defaults to English with no signals at all", () => {
		const locale = resolveEmailLocale(undefined, request());

		expect(locale).toBe("en");
	});

	it("ignores an unsupported cookie locale and keeps resolving", () => {
		const locale = resolveEmailLocale(
			null,
			request({ cookie: "emdash-locale=xx", "accept-language": "ja" }),
		);

		expect(locale).toBe("ja");
	});

	it("canonicalizes a non-canonical site locale so it finds its catalog", () => {
		const locale = resolveEmailLocale("pt-br", request());

		expect(locale).toBe("pt-BR");
	});

	it("falls through to the requester's locale when the site locale is unsupported", () => {
		const locale = resolveEmailLocale("not a locale", request({ cookie: "emdash-locale=fr" }));

		expect(locale).toBe("fr");
	});
});
