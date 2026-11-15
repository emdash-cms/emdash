import { describe, expect, it } from "vitest";

import type { SiteSettings } from "../../src/lib/api/settings.js";
import { getSiteColor, getSiteLogoAlt, getSiteLogoUrl } from "../../src/lib/site-settings-context.js";

describe("site settings helpers", () => {
	it("uses the resolved logo URL and accessible name from settings", () => {
		const settings: Partial<SiteSettings> = {
			title: "My Blog",
			logo: { mediaId: "logo-1", alt: "My Blog logo", url: "/media/logo.svg" },
		};

		expect(getSiteLogoUrl(settings)).toBe("/media/logo.svg");
		expect(getSiteLogoAlt(settings, "Logo")).toBe("My Blog logo");
	});

	it("falls back to the site title or supplied label when the logo has no alt text", () => {
		expect(getSiteLogoAlt({ title: "My Blog" }, "Logo")).toBe("My Blog");
		expect(getSiteLogoAlt({}, "Logo")).toBe("Logo");
		expect(getSiteLogoAlt(undefined, "Logo")).toBe("Logo");
	});

	it("uses black when a requested color is not configured", () => {
		expect(getSiteColor(undefined, "primary")).toBe("#000000");
		expect(getSiteColor({ theme: { colors: { primary: "#336699" } } }, "primary")).toBe("#336699");
		expect(getSiteColor({ theme: { colors: {} } }, "secondary")).toBe("#000000");
	});
});
