import { describe, expect, test } from "vitest";

import {
	DEFAULT_LOCALE,
	loadMessages,
	resolveLocale,
	SUPPORTED_LOCALES,
} from "../../src/locales/index.js";

for (const { code } of SUPPORTED_LOCALES) {
	test(`loadMessages resolves catalog for supported locale "${code}"`, async () => {
		const messages = await loadMessages(code);
		expect(messages).toBeDefined();
		expect(typeof messages).toBe("object");
		expect(Object.keys(messages).length).toBeGreaterThan(0);
	});
}

test("loadMessages falls back to English for unknown locale", async () => {
	const [fallback, english] = await Promise.all([loadMessages("xx"), loadMessages("en")]);
	expect(fallback).toEqual(english);
});

// -- resolveLocale ---------------------------------------------------------

/**
 * Build a Request with the given headers. Browser environments silently
 * strip the `cookie` header (forbidden header name) from Request/Headers,
 * so we override `.get()` to inject it for testing purposes.
 */
function makeRequest(headers: Record<string, string> = {}): Request {
	const { cookie, ...rest } = headers;
	const req = new Request("http://localhost/", { headers: rest });
	if (cookie) {
		const original = req.headers.get.bind(req.headers);
		req.headers.get = (name: string) => (name.toLowerCase() === "cookie" ? cookie : original(name));
	}
	return req;
}

describe("resolveLocale", () => {
	test("returns DEFAULT_LOCALE when no cookie or accept-language", () => {
		expect(resolveLocale(makeRequest())).toBe(DEFAULT_LOCALE);
	});

	// Cookie precedence
	test("returns locale from emdash-locale cookie", () => {
		expect(resolveLocale(makeRequest({ cookie: "emdash-locale=de" }))).toBe("de");
	});

	test("ignores cookie with unsupported locale", () => {
		expect(resolveLocale(makeRequest({ cookie: "emdash-locale=xx" }))).toBe(DEFAULT_LOCALE);
	});

	test("cookie takes precedence over accept-language", () => {
		expect(
			resolveLocale(
				makeRequest({
					cookie: "emdash-locale=de",
					"accept-language": "fr",
				}),
			),
		).toBe("de");
	});

	// Accept-Language exact match
	test("matches exact accept-language tag", () => {
		expect(resolveLocale(makeRequest({ "accept-language": "de" }))).toBe("de");
	});

	test("matches accept-language with region (pt-BR)", () => {
		expect(resolveLocale(makeRequest({ "accept-language": "pt-BR" }))).toBe("pt-BR");
	});

	// Accept-Language case insensitivity (fix for Copilot review #4)
	test("matches accept-language case-insensitively (pt-br -> pt-BR)", () => {
		expect(resolveLocale(makeRequest({ "accept-language": "pt-br" }))).toBe("pt-BR");
	});

	test("matches accept-language case-insensitively (ZH-CN -> zh-CN)", () => {
		expect(resolveLocale(makeRequest({ "accept-language": "ZH-CN" }))).toBe("zh-CN");
	});

	test("matches accept-language case-insensitively (DE -> de)", () => {
		expect(resolveLocale(makeRequest({ "accept-language": "DE" }))).toBe("de");
	});

	// Accept-Language base language fallback
	test("falls back to base language (pt-PT -> pt-BR)", () => {
		expect(resolveLocale(makeRequest({ "accept-language": "pt-PT" }))).toBe("pt-BR");
	});

	test("falls back to base language (zh-TW -> zh-CN)", () => {
		expect(resolveLocale(makeRequest({ "accept-language": "zh-TW" }))).toBe("zh-CN");
	});

	// Accept-Language with quality weights
	test("respects order in accept-language list", () => {
		expect(resolveLocale(makeRequest({ "accept-language": "fr;q=0.9, de;q=1.0" }))).toBe("fr");
	});

	test("skips unsupported languages in accept-language list", () => {
		expect(resolveLocale(makeRequest({ "accept-language": "xx, yy, de" }))).toBe("de");
	});

	// Malformed input
	test("handles empty accept-language gracefully", () => {
		expect(resolveLocale(makeRequest({ "accept-language": "" }))).toBe(DEFAULT_LOCALE);
	});

	test("handles garbage accept-language gracefully", () => {
		expect(resolveLocale(makeRequest({ "accept-language": "not-a-real-locale-tag!!!" }))).toBe(
			DEFAULT_LOCALE,
		);
	});
});
