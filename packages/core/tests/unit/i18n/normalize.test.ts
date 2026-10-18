import { afterEach, describe, expect, it } from "vitest";

import {
	getFallbackChain,
	resolveContentCreateLocale,
	setI18nConfig,
} from "../../../src/i18n/config.js";
import { normalizeAstroI18n } from "../../../src/i18n/normalize.js";
import { resolveLocale } from "../../../src/i18n/resolve.js";

describe("normalizeAstroI18n", () => {
	afterEach(() => setI18nConfig(null));

	it("resolves object codes, default locale, and fallbacks to content paths", () => {
		setI18nConfig(
			normalizeAstroI18n({
				defaultLocale: "es-MX",
				locales: [
					{ path: "es", codes: ["es-MX"] },
					{ path: "en", codes: ["en-US", "en-GB"] },
					{ path: "fr", codes: ["fr-CA"] },
				],
				fallback: { "fr-CA": "en-GB", en: "es-MX" },
			}),
		);

		expect(resolveContentCreateLocale(undefined)).toBe("es");
		expect(resolveContentCreateLocale("EN-us")).toBe("en");
		expect(resolveLocale()).toBe("es");
		expect(resolveLocale("en-GB")).toBe("en");
		expect(getFallbackChain("fr-CA")).toEqual(["fr", "en", "es"]);
		expect(getFallbackChain("en")).toEqual(["en", "es"]);
		expect(resolveLocale("de-DE")).toBe("de-DE");
		expect(() => resolveContentCreateLocale("de-DE")).toThrow("not configured");
	});
	it("returns null when Astro i18n is not configured", () => {
		expect(normalizeAstroI18n(undefined)).toBeNull();
	});

	it("preserves string locales and a custom default locale", () => {
		expect(
			normalizeAstroI18n({
				defaultLocale: "fr",
				locales: ["en", "fr"],
			}),
		).toEqual({
			defaultLocale: "fr",
			locales: ["en", "fr"],
			fallback: undefined,
			prefixDefaultLocale: false,
		});
	});

	it("normalizes locale objects to their configured paths", () => {
		expect(
			normalizeAstroI18n({
				defaultLocale: "english",
				locales: [
					{ path: "english", codes: ["en", "en-US"] },
					{ path: "french", codes: ["fr", "fr-FR"] },
				],
			}),
		).toMatchObject({
			defaultLocale: "english",
			locales: ["english", "french"],
		});
	});

	it("preserves fallback and prefixDefaultLocale routing", () => {
		const fallback = { "fr-CA": "fr", fr: "en" };

		expect(
			normalizeAstroI18n({
				defaultLocale: "en",
				locales: ["en", "fr", "fr-CA"],
				fallback,
				routing: { prefixDefaultLocale: true },
			}),
		).toEqual({
			defaultLocale: "en",
			locales: ["en", "fr", "fr-CA"],
			fallback,
			prefixDefaultLocale: true,
		});
	});
});
