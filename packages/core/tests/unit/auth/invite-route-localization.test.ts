/**
 * Invite route email localization: the POST handler resolves the email
 * locale from the site `emdash:locale` option and threads it (and the
 * localized copy) into the sent message. Each layer is unit-tested on
 * its own; this covers the route seam where the wiring lives.
 */

import type { EmailMessage } from "@emdash-cms/auth";
import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { POST as invitePost } from "../../../src/astro/routes/api/auth/invite/index.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("invite route — email localization wiring", () => {
	let db: Kysely<Database>;
	let admin: { id: string; role: number };
	let sentEmails: EmailMessage[];

	beforeEach(async () => {
		db = await setupTestDatabase();
		sentEmails = [];

		const created = await createKyselyAdapter(db).createUser({
			email: "admin@example.com",
			name: "Admin",
			role: Role.ADMIN,
			emailVerified: true,
		});
		admin = { id: created.id, role: created.role };
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function postInvite(): Promise<Response> {
		const request = new Request("http://test.local/_emdash/api/auth/invite", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ email: "invitee@example.com" }),
		});

		return invitePost({
			request,
			locals: {
				user: admin,
				emdash: {
					db,
					config: { siteUrl: "https://example.com" },
					email: {
						isAvailable: () => true,
						send: async (message: EmailMessage) => {
							sentEmails.push(message);
						},
					},
				},
			},
		} as unknown as Parameters<typeof invitePost>[0]);
	}

	it("threads the site locale into the sent email's lang/dir", async () => {
		await new OptionsRepository(db).set("emdash:locale", "ar");

		const response = await postInvite();

		expect(response.status).toBe(200);
		expect(sentEmails).toHaveLength(1);
		expect(sentEmails[0]!.html).toContain('lang="ar"');
		expect(sentEmails[0]!.html).toContain('dir="rtl"');
	});

	it("defaults to English lang/ltr without a site locale", async () => {
		const response = await postInvite();

		expect(response.status).toBe(200);
		expect(sentEmails).toHaveLength(1);
		expect(sentEmails[0]!.html).toContain('lang="en"');
		expect(sentEmails[0]!.html).toContain('dir="ltr"');
	});
});
