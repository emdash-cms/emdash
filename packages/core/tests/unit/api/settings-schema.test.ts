import { describe, expect, it } from "vitest";

import { settingsUpdateBody, siteSettingsSchema } from "../../../src/api/schemas/settings.js";

describe("settings schemas", () => {
	it("accepts null media references as deletion requests", () => {
		expect(
			settingsUpdateBody.parse({
				logo: null,
				favicon: null,
				seo: { defaultOgImage: null },
			}),
		).toEqual({ logo: null, favicon: null, seo: { defaultOgImage: null } });
	});

	it("does not expose deletion sentinels in settings responses", () => {
		expect(siteSettingsSchema.safeParse({ logo: null }).success).toBe(false);
		expect(siteSettingsSchema.safeParse({ favicon: null }).success).toBe(false);
		expect(siteSettingsSchema.safeParse({ seo: { defaultOgImage: null } }).success).toBe(false);
	});
});
