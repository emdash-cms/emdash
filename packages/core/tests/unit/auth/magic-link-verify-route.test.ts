import type { EmailMessage } from "@emdash-cms/auth";
import { Role, sendMagicLink } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import {
	GET as openLink,
	POST as confirmLink,
} from "../../../src/astro/routes/api/auth/magic-link/verify.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function redirect(path: string) {
	return new Response(null, { status: 302, headers: { Location: path } });
}

describe("magic link verify route", () => {
	let db: Kysely<Database>;
	let userId: string;
	let linkUrl: URL;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const adapter = createKyselyAdapter(db);
		const user = await adapter.createUser({
			email: "author@example.com",
			name: "Author",
			role: Role.AUTHOR,
			emailVerified: true,
		});
		userId = user.id;

		let sent: EmailMessage | undefined;
		await sendMagicLink(
			{
				baseUrl: "https://example.com",
				siteName: "Test",
				email: async (message) => {
					sent = message;
				},
			},
			adapter,
			"author@example.com",
		);
		const href = sent?.text.match(/https:\/\/\S+/)?.[0];
		if (!href) throw new Error("magic link email carried no link");
		linkUrl = new URL(href);
		linkUrl.searchParams.set("redirect", "/_emdash/admin/content/posts");
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	function confirm(token: string, session = { set: vi.fn() }) {
		const request = new Request("https://example.com/_emdash/api/auth/magic-link/verify", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ token }),
		});
		return confirmLink({
			request,
			locals: { emdash: { db, config: {} } },
			session,
		} as unknown as Parameters<typeof confirmLink>[0]);
	}

	it("opening the link forwards to the confirmation page without using the token", async () => {
		const token = linkUrl.searchParams.get("token")!;

		const first = await openLink({ url: linkUrl, redirect } as unknown as Parameters<
			typeof openLink
		>[0]);
		await openLink({ url: linkUrl, redirect } as unknown as Parameters<typeof openLink>[0]);

		const location = new URL(first.headers.get("Location")!, "https://example.com");
		expect(location.pathname).toBe("/_emdash/admin/login/magic-link");
		expect(location.searchParams.get("token")).toBe(token);
		expect(location.searchParams.get("redirect")).toBe("/_emdash/admin/content/posts");

		const session = { set: vi.fn() };
		const response = await confirm(token, session);
		expect(response.status).toBe(200);
		expect(session.set).toHaveBeenCalledWith("user", { id: userId });
	});

	it("confirming uses the token once", async () => {
		const token = linkUrl.searchParams.get("token")!;
		expect((await confirm(token)).status).toBe(200);

		const session = { set: vi.fn() };
		const replay = await confirm(token, session);
		expect(replay.status).toBe(400);
		await expect(replay.json()).resolves.toMatchObject({
			success: false,
			error: { code: "INVALID_TOKEN" },
		});
		expect(session.set).not.toHaveBeenCalled();
	});
});
