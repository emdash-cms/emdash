/**
 * System email copy resolution tests (#915): the helpers resolve the
 * module-scope descriptors through the Lingui catalog for the requested
 * locale, interpolate the site name, and fall back to English for
 * unknown locales. (Whether individual strings are translated depends
 * on catalog coverage, so assertions stick to the English source and
 * the fallback path.)
 */

import { describe, expect, test } from "vitest";

import { getInviteEmailStrings, getMagicLinkEmailStrings } from "../../src/locales/emails.js";

describe("getInviteEmailStrings", () => {
	test("resolves English copy with the site name interpolated", async () => {
		const strings = await getInviteEmailStrings("en", "Acme");

		expect(strings.subject).toBe("You've been invited to Acme");
		expect(strings.textIntro).toBe("You've been invited to join Acme.");
		expect(strings.buttonLabel).toBe("Accept Invite");
		expect(strings.expiryNote).toBe("This link expires in 7 days.");
	});

	test("falls back to English for an unknown locale", async () => {
		const strings = await getInviteEmailStrings("xx-XX", "Acme");

		expect(strings.subject).toBe("You've been invited to Acme");
	});

	test("resolves every field to a non-empty string for all enabled locales", async () => {
		for (const locale of ["de", "ja", "ar", "pt-BR"]) {
			const strings = await getInviteEmailStrings(locale, "Acme");
			for (const value of Object.values(strings)) {
				expect(value).toBeTruthy();
			}
		}
	});
});

describe("getMagicLinkEmailStrings", () => {
	test("resolves English copy with the site name interpolated", async () => {
		const strings = await getMagicLinkEmailStrings("en", "Acme");

		expect(strings.subject).toBe("Sign in to Acme");
		expect(strings.textLinkInstruction).toBe("Click this link to sign in to Acme:");
		expect(strings.ignoreNote).toBe(
			"If you didn't request this, you can safely ignore this email.",
		);
	});
});
