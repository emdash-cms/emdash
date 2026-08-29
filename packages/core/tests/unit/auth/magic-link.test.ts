import type { AuthAdapter, EmailSendFn } from "@emdash-cms/auth";
import type { EmailMessage } from "@emdash-cms/auth";
import { Role, sendMagicLink } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { GET as verifyMagicLinkRoute } from "../../../src/astro/routes/api/auth/magic-link/verify.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("Magic Link", () => {
	let db: Kysely<Database>;
	let adapter: AuthAdapter;
	let mockEmailSend: EmailSendFn & ReturnType<typeof vi.fn>;
	let sentEmails: Array<EmailMessage>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		adapter = createKyselyAdapter(db);
		sentEmails = [];
		mockEmailSend = vi.fn(async (email: EmailMessage) => {
			sentEmails.push(email);
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("sends verify links through the injected EmDash auth route", async () => {
		await adapter.createUser({
			email: "author@example.com",
			name: "Author",
			role: Role.AUTHOR,
			emailVerified: true,
		});

		await sendMagicLink(
			{
				baseUrl: "https://example.com",
				siteName: "Test Site",
				email: mockEmailSend,
			},
			adapter,
			"author@example.com",
		);

		expect(mockEmailSend).toHaveBeenCalledOnce();
		expect(sentEmails[0]!.text).toContain(
			"https://example.com/_emdash/api/auth/magic-link/verify?token=",
		);
	});

	it("rejects a disabled user without creating a session", async () => {
		const user = await adapter.createUser({
			email: "disabled@example.com",
			name: "Disabled User",
			role: Role.AUTHOR,
			emailVerified: true,
		});

		await sendMagicLink(
			{
				baseUrl: "https://example.com",
				siteName: "Test Site",
				email: mockEmailSend,
			},
			adapter,
			user.email,
		);
		await adapter.updateUser(user.id, { disabled: true });

		const verificationUrl = sentEmails[0]!.text.match(/https:\/\/\S+/)?.[0];
		expect(verificationUrl).toBeDefined();
		const set = vi.fn();
		const response = await verifyMagicLinkRoute({
			url: new URL(verificationUrl!),
			locals: { emdash: { db, config: {} } },
			session: { set },
			redirect: (location: string) =>
				new Response(null, { status: 302, headers: { Location: location } }),
		} as never);

		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toContain("error=account_disabled");
		expect(set).not.toHaveBeenCalled();
	});
});
