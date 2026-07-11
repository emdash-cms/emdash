/**
 * System email builder tests (#915): the builders default to English
 * and render injected localized copy verbatim (text) / escaped (HTML).
 */

import { describe, expect, it } from "vitest";

import { buildInviteEmail, type InviteEmailStrings } from "./invite.js";
import { buildMagicLinkEmail, type MagicLinkEmailStrings } from "./magic-link/index.js";

const URL = "https://example.com/_emdash/admin/invite/accept?token=abc";

describe("buildInviteEmail", () => {
	it("defaults to English copy with the site name interpolated", () => {
		const message = buildInviteEmail(URL, "new@example.com", "Acme");

		expect(message.to).toBe("new@example.com");
		expect(message.subject).toBe("You've been invited to Acme");
		expect(message.text).toContain("You've been invited to join Acme.");
		expect(message.text).toContain(URL);
		expect(message.html).toContain("Accept Invite");
	});

	it("renders injected localized copy", () => {
		const strings: InviteEmailStrings = {
			subject: "Du wurdest zu Acme eingeladen",
			textIntro: "Du wurdest eingeladen, Acme beizutreten.",
			textLinkInstruction: "Klicke auf diesen Link, um dein Konto zu erstellen:",
			htmlInstruction: "Klicke auf den Button unten, um dein Konto zu erstellen:",
			buttonLabel: "Einladung annehmen",
			expiryNote: "Dieser Link läuft in 7 Tagen ab.",
		};

		const message = buildInviteEmail(URL, "new@example.com", "Acme", strings);

		expect(message.subject).toBe("Du wurdest zu Acme eingeladen");
		expect(message.text).toContain("Du wurdest eingeladen, Acme beizutreten.");
		expect(message.text).toContain(URL);
		expect(message.html).toContain("Einladung annehmen");
		expect(message.html).not.toContain("Accept Invite");
	});

	it("HTML-escapes localized strings (site names and translations are untrusted)", () => {
		const message = buildInviteEmail(URL, "new@example.com", `<b>"Acme"</b>`);

		expect(message.html).toContain("&lt;b&gt;&quot;Acme&quot;&lt;/b&gt;");
		expect(message.html).not.toContain(`<b>"Acme"</b>`);
	});
});

describe("buildMagicLinkEmail", () => {
	it("defaults to English copy with the site name interpolated", () => {
		const message = buildMagicLinkEmail(URL, "user@example.com", "Acme");

		expect(message.subject).toBe("Sign in to Acme");
		expect(message.text).toContain("Click this link to sign in to Acme:");
		expect(message.text).toContain(URL);
		expect(message.html).toContain("Sign in");
	});

	it("renders injected localized copy", () => {
		const strings: MagicLinkEmailStrings = {
			subject: "Bei Acme anmelden",
			textLinkInstruction: "Klicke auf diesen Link, um dich bei Acme anzumelden:",
			htmlInstruction: "Klicke auf den Button unten, um dich anzumelden:",
			buttonLabel: "Anmelden",
			expiryNote: "Dieser Link läuft in 15 Minuten ab.",
			ignoreNote: "Wenn du das nicht angefordert hast, kannst du diese E-Mail ignorieren.",
		};

		const message = buildMagicLinkEmail(URL, "user@example.com", "Acme", strings);

		expect(message.subject).toBe("Bei Acme anmelden");
		expect(message.text).toContain(URL);
		expect(message.html).toContain("Anmelden");
		expect(message.html).not.toContain("Sign in to Acme");
	});

	it("HTML-escapes localized strings", () => {
		const message = buildMagicLinkEmail(URL, "user@example.com", `<script>Acme</script>`);

		expect(message.html).not.toContain("<script>");
	});
});
