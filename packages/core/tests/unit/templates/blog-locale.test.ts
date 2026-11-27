import type { APIContext, APIRoute } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { GET as cloudflareFeed } from "../../../../../templates/blog-cloudflare/src/pages/rss.xml";
import * as cloudflareLocale from "../../../../../templates/blog-cloudflare/src/utils/locale";
import { GET as nodeFeed } from "../../../../../templates/blog/src/pages/rss.xml";
import * as nodeLocale from "../../../../../templates/blog/src/utils/locale";

const i18n = vi.hoisted(() => ({
	config: null as { defaultLocale: string; locales: string[] } | null,
}));

vi.mock("emdash", () => ({
	getI18nConfig: () => i18n.config,
	getSiteSettings: async () => ({}),
	getEmDashCollection: async () => ({ entries: [] }),
}));

function setDefaultLocale(locale: string | null): void {
	i18n.config = locale ? { defaultLocale: locale, locales: [locale] } : null;
}

async function feedLanguage(feed: APIRoute): Promise<string | undefined> {
	const context = { site: undefined, url: new URL("https://example.com/rss.xml") };
	const response = await feed(context as unknown as APIContext);
	return (await response.text()).match(/<language>([^<]*)<\/language>/)?.[1];
}

// Local noon, so the calendar date doesn't depend on the test machine's time zone.
const date = new Date(2026, 9, 7, 12);

describe.each([
	["Node", nodeLocale, nodeFeed],
	["Cloudflare", cloudflareLocale, cloudflareFeed],
] as const)("%s blog locale", (_name, { formatDate, getSiteLocale }, feed) => {
	// Both templates share one formatter cache on globalThis; clear it so each copy builds its own formatters.
	beforeEach(() => {
		const formats = (globalThis as Record<symbol, unknown>)[
			Symbol.for("emdash:template-blog:date-formats")
		];
		if (formats instanceof Map) formats.clear();
	});

	it("stays English when i18n isn't configured", async () => {
		setDefaultLocale(null);
		expect(getSiteLocale()).toBeUndefined();
		expect(formatDate(date, "long")).toBe("October 7, 2026");
		expect(formatDate(date, "short")).toBe("Oct 7, 2026");
		expect(await feedLanguage(feed)).toBe("en-us");
	});

	it("follows the configured default locale", async () => {
		setDefaultLocale("fr");
		expect(getSiteLocale()).toBe("fr");
		expect(formatDate(date, "long")).toBe("7 octobre 2026");
		expect(await feedLanguage(feed)).toBe("fr");
	});

	it("follows a locale change between calls", () => {
		setDefaultLocale("fr");
		expect(formatDate(date, "long")).toBe("7 octobre 2026");
		setDefaultLocale("de");
		expect(formatDate(date, "long")).toBe("7. Oktober 2026");
		expect(formatDate(date, "short")).toBe("7. Okt. 2026");
		setDefaultLocale(null);
		expect(formatDate(date, "short")).toBe("Oct 7, 2026");
	});

	it("renders an invalid date as text instead of throwing", () => {
		setDefaultLocale(null);
		expect(formatDate(new Date(Number.NaN), "long")).toBe("Invalid Date");
	});

	it.each([
		["a malformed tag", "pt_BR"],
		["an Astro custom locale path", "spanish"],
	])("stays English for %s", async (_case, locale) => {
		setDefaultLocale(locale);
		expect(getSiteLocale()).toBeUndefined();
		expect(formatDate(date, "long")).toBe("October 7, 2026");
		expect(await feedLanguage(feed)).toBe("en-us");
	});
});
