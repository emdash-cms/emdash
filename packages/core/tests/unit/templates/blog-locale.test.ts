import type { APIContext, APIRoute } from "astro";
import { describe, expect, it, vi } from "vitest";

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
