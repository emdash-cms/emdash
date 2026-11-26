/**
 * Email Settings Route Registration Test
 *
 * Regression test for https://github.com/emdash-cms/emdash/issues/151
 * The email settings API route file existed but was never registered
 * via injectRoute(), causing the endpoint to return 404.
 */

import type { EmailMessage } from "@emdash-cms/auth";
import { Role } from "@emdash-cms/auth";
import { describe, expect, it, vi } from "vitest";

import { injectCoreRoutes } from "../../../src/astro/integration/routes.js";
import { POST as sendTestEmail } from "../../../src/astro/routes/api/settings/email.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("email settings route registration (#151)", () => {
	it("registers /_emdash/api/settings/email route", () => {
		const injectRoute = vi.fn();

		injectCoreRoutes(injectRoute);

		const patterns = injectRoute.mock.calls.map((call) => (call[0] as { pattern: string }).pattern);
		expect(patterns).toContain("/_emdash/api/settings/email");
	});
});

describe("email settings test email site name (#4642)", () => {
	async function sendEmailWithOptions(options: Record<string, string | boolean>) {
		const db = await setupTestDatabase();
		try {
			const optionsRepo = new OptionsRepository(db);
			for (const [name, value] of Object.entries(options)) await optionsRepo.set(name, value);

			let subject = "";
			const response = await sendTestEmail({
				request: new Request("https://example.com/_emdash/api/settings/email/test", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ to: "admin@example.com" }),
				}),
				locals: {
					emdash: {
						db,
						email: {
							isAvailable: () => true,
							send: async (message: EmailMessage) => {
								subject = message.subject;
							},
						},
					},
					user: { id: "admin", role: Role.ADMIN },
				},
			} as unknown as Parameters<typeof sendTestEmail>[0]);

			expect(response.status).toBe(200);
			return subject;
		} finally {
			await teardownTestDatabase(db);
		}
	}

	it("uses the Settings title without a setup title", async () => {
		expect(await sendEmailWithOptions({ "site:title": "Settings Site" })).toBe(
			"Test email from Settings Site",
		);
	});

	it("falls back to the setup title when Settings is empty", async () => {
		expect(
			await sendEmailWithOptions({ "site:title": "", "emdash:site_title": "Setup Site" }),
		).toBe("Test email from Setup Site");
	});

	it("uses EmDash when neither title is stored", async () => {
		expect(await sendEmailWithOptions({})).toBe("Test email from EmDash");
	});

	it("prefers Settings site:title over the setup title", async () => {
		expect(
			await sendEmailWithOptions({ "site:title": "New Site", "emdash:site_title": "Old Site" }),
		).toBe("Test email from New Site");
	});
});
