import type { User } from "@emdash-cms/auth";
import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { POST as createHandover } from "../../../src/astro/routes/api/auth/handover.js";
import { POST as confirmLink } from "../../../src/astro/routes/api/auth/magic-link/verify.js";
import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("sign-in handover route", () => {
	let db: Kysely<Database>;
	let user: User;

	beforeEach(async () => {
		db = await setupTestDatabase();
		user = await createKyselyAdapter(db).createUser({
			email: "admin@example.com",
			name: "Admin",
			role: Role.ADMIN,
			emailVerified: true,
		});
		const options = new OptionsRepository(db);
		await options.set("emdash:site_url", "https://old.workers.dev");
		await options.set("site:url", "https://new.example");
	});

	afterEach(async () => {
		vi.useRealTimers();
		await teardownTestDatabase(db);
	});

	async function handover(host: string, extraLocals: Record<string, unknown> = {}) {
		const response = await createHandover({
			request: new Request(`https://${host}/_emdash/api/auth/handover`, { method: "POST" }),
			locals: { emdash: { db, config: {} }, user, ...extraLocals },
		} as unknown as Parameters<typeof createHandover>[0]);
		return response;
	}

	async function linkFrom(host: string): Promise<URL> {
		const response = await handover(host);
		expect(response.status).toBe(200);
		const body: { data: { url: string } } = await response.json();
		return new URL(body.data.url);
	}

	function confirm(token: string, session = { set: vi.fn() }) {
		return confirmLink({
			request: new Request("https://new.example/_emdash/api/auth/magic-link/verify", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ token }),
			}),
			locals: { emdash: { db, config: {} } },
			session,
		} as unknown as Parameters<typeof confirmLink>[0]);
	}

	it("links to the Site URL and opens Security settings to add a passkey", async () => {
		const link = await linkFrom("old.workers.dev");

		expect(link.origin).toBe("https://new.example");
		expect(link.pathname).toBe("/_emdash/api/auth/magic-link/verify");
		expect(link.searchParams.get("redirect")).toBe("/_emdash/admin/settings/security?addPasskey=1");
	});

	it("ignores the request host", async () => {
		const link = await linkFrom("attacker.example");
		expect(link.origin).toBe("https://new.example");
	});

	it("signs the same user in once", async () => {
		const token = (await linkFrom("old.workers.dev")).searchParams.get("token")!;

		const session = { set: vi.fn() };
		expect((await confirm(token, session)).status).toBe(200);
		expect(session.set).toHaveBeenCalledWith("user", { id: user.id });

		expect((await confirm(token)).status).toBe(400);
	});

	it("expires after five minutes", async () => {
		const token = (await linkFrom("old.workers.dev")).searchParams.get("token")!;

		vi.useFakeTimers({ toFake: ["Date"] });
		vi.setSystemTime(Date.now() + 5 * 60 * 1000 + 1000);

		const response = await confirm(token);
		expect(response.status).toBe(410);
	});

	it("does not link to the address recorded during setup", async () => {
		await new OptionsRepository(db).delete("site:url");

		const response = await handover("custom.example");
		expect(response.status).toBe(409);
		await expect(response.json()).resolves.toMatchObject({ error: { code: "NO_SITE_URL" } });
	});

	it("links to the configured siteUrl before the Site URL", async () => {
		const response = await createHandover({
			request: new Request("https://old.workers.dev/_emdash/api/auth/handover", { method: "POST" }),
			locals: { emdash: { db, config: { siteUrl: "https://configured.example" } }, user },
		} as unknown as Parameters<typeof createHandover>[0]);
		const body: { data: { url: string } } = await response.json();
		expect(new URL(body.data.url).origin).toBe("https://configured.example");
	});

	it("limits how many links a user can create", async () => {
		for (let i = 0; i < 5; i++) {
			expect((await handover("old.workers.dev")).status).toBe(200);
		}
		expect((await handover("old.workers.dev")).status).toBe(429);
	});

	it("refuses API and OAuth tokens", async () => {
		const response = await handover("old.workers.dev", { tokenScopes: ["admin"] });
		expect(response.status).toBe(403);
	});

	it("requires a signed-in user", async () => {
		const response = await handover("old.workers.dev", { user: undefined });
		expect(response.status).toBe(401);
	});
});
