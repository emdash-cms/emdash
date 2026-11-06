import type { EmailMessage, User } from "@emdash-cms/auth";
import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { POST } from "../../../src/astro/routes/api/settings/domain-notify.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("domain move notice route", () => {
	let db: Kysely<Database>;
	let admin: User;
	let sent: EmailMessage[];

	beforeEach(async () => {
		db = await setupTestDatabase();
		const adapter = createKyselyAdapter(db);
		admin = await adapter.createUser({
			email: "admin@example.com",
			name: "Admin",
			role: Role.ADMIN,
			emailVerified: true,
		});
		await adapter.createUser({
			email: "editor@example.com",
			role: Role.EDITOR,
			emailVerified: true,
		});
		const disabled = await adapter.createUser({
			email: "gone@example.com",
			role: Role.AUTHOR,
			emailVerified: true,
		});
		await db.updateTable("users").set({ disabled: 1 }).where("id", "=", disabled.id).execute();

		const options = new OptionsRepository(db);
		await options.set("site:url", "https://new.example");
		await options.set("emdash:site_title", "Field Notes");
		sent = [];
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	function notify(
		overrides: {
			user?: User | undefined;
			emailAvailable?: boolean;
			failFor?: string;
			config?: Record<string, unknown>;
			tokenScopes?: string[];
		} = {},
	) {
		const email = {
			isAvailable: () => overrides.emailAvailable ?? true,
			send: async (message: EmailMessage) => {
				if (message.to === overrides.failFor) throw new Error("provider down");
				sent.push(message);
			},
		};
		return POST({
			request: new Request("https://old.workers.dev/_emdash/api/settings/domain/notify", {
				method: "POST",
			}),
			locals: {
				emdash: { db, config: overrides.config ?? {}, email },
				user: "user" in overrides ? overrides.user : admin,
				tokenScopes: overrides.tokenScopes,
			},
		} as unknown as Parameters<typeof POST>[0]);
	}

	it("emails every other active user a link to sign in at the new address", async () => {
		const response = await notify();

		expect(response.status).toBe(200);
		await expect(response.json()).resolves.toMatchObject({ data: { sent: 1, failed: 0 } });
		expect(sent.map((m) => m.to)).toEqual(["editor@example.com"]);
		expect(sent[0]!.subject).toBe("Field Notes has moved to new.example");
		expect(sent[0]!.html).toContain('href="https://new.example/_emdash/admin/login"');
		expect(sent[0]!.text).toContain("https://new.example/_emdash/admin/login");
	});

	it("escapes the site title in the email", async () => {
		await new OptionsRepository(db).set("emdash:site_title", "<b>Notes</b>");
		await notify();
		expect(sent[0]!.html).toContain("&lt;b&gt;Notes&lt;/b&gt;");
		expect(sent[0]!.html).not.toContain("<b>Notes</b>");
	});

	it("counts emails the provider rejects and keeps sending", async () => {
		await createKyselyAdapter(db).createUser({
			email: "writer@example.com",
			role: Role.AUTHOR,
			emailVerified: true,
		});

		const response = await notify({ failFor: "editor@example.com" });

		await expect(response.json()).resolves.toMatchObject({ data: { sent: 1, failed: 1 } });
		expect(sent.map((m) => m.to)).toEqual(["writer@example.com"]);
	});

	it("needs an email provider", async () => {
		const response = await notify({ emailAvailable: false });
		expect(response.status).toBe(503);
		expect(sent).toEqual([]);
	});

	it("needs a Site URL", async () => {
		await new OptionsRepository(db).delete("site:url");
		const response = await notify();
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({ error: { code: "NO_SITE_URL" } });
	});

	it("is limited to admins", async () => {
		const editor = await createKyselyAdapter(db).getUserByEmail("editor@example.com");
		const response = await notify({ user: editor! });
		expect(response.status).toBe(403);
		expect(sent).toEqual([]);
	});

	it("refuses API and OAuth tokens", async () => {
		const response = await notify({ tokenScopes: ["settings:manage"] });
		expect(response.status).toBe(403);
		expect(sent).toEqual([]);
	});

	it("is not offered when an external provider handles sign-in", async () => {
		const response = await notify({
			config: { auth: { type: "cloudflare-access", entrypoint: "@emdash-cms/cloudflare/auth" } },
		});
		expect(response.status).toBe(400);
		expect(sent).toEqual([]);
	});

	it("requires a signed-in user", async () => {
		const response = await notify({ user: undefined });
		expect(response.status).toBe(401);
	});

	it("limits how often users can be emailed", async () => {
		for (let i = 0; i < 3; i++) {
			expect((await notify()).status).toBe(200);
		}
		expect((await notify()).status).toBe(429);
	});
});
