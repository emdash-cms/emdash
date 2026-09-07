import { describe, expect, it } from "vitest";

import { normalizeAstroI18n } from "../../../src/i18n/normalize.js";

describe("normalizeAstroI18n", () => {
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
