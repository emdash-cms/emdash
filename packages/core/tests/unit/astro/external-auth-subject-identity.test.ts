import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { handleApiTokenCreate } from "../../../src/api/handlers/api-tokens.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { authenticate } = vi.hoisted(() => ({ authenticate: vi.fn() }));
vi.mock("virtual:emdash/auth", () => ({ authenticate }), { virtual: true });
const virtualConfig = vi.hoisted(() => ({}) as Record<string, unknown>);
vi.mock("virtual:emdash/config", () => ({ default: virtualConfig }), { virtual: true });
vi.mock("../../../src/astro/session-user.js", () => ({
	resolveSessionUser: vi.fn(async () => null),
}));

let onRequest: typeof import("../../../src/astro/middleware/auth.js").onRequest;

beforeAll(async () => {
	vi.stubEnv("DEV", false);
	({ onRequest } = await import("../../../src/astro/middleware/auth.js"));
});

afterAll(() => vi.unstubAllEnvs());

type Identity = { subject?: string; email: string; name: string; role: number };
const identity = (overrides: Partial<Identity> = {}): Identity => ({
	subject: "siteboulder-user-1",
	email: "owner@example.test",
	name: "Site Owner",
	role: 40,
	...overrides,
});

async function request(
	db: Kysely<Database>,
	assertion: Identity,
	config: Record<string, unknown> = {},
) {
	authenticate.mockResolvedValue(assertion);
	const locals: Record<string, unknown> = {
		emdash: {
			db,
			config: {
				auth: {
					type: "siteboulder",
					entrypoint: "@siteboulder/emdash-auth",
					config: { identityMode: "subject", ...config },
				},
			},
			getPluginRouteMeta: vi.fn(() => ({ public: false })),
		},
	};
	const url = new URL("/_emdash/api/plugins/inquiries/list", "https://site-one.example.test");
	const session = { get: vi.fn(async () => null), set: vi.fn() };
	const response = await onRequest(
		{
			request: new Request(url),
			url,
			locals,
			session,
			redirect: vi.fn(),
		} as never,
		async () => new Response("ok"),
	);
	return { response, locals, session };
}

async function publicPage(db: Kysely<Database>, assertion: Identity | Error) {
	if (assertion instanceof Error) authenticate.mockRejectedValue(assertion);
	else authenticate.mockResolvedValue(assertion);
	const locals: Record<string, unknown> = {
		emdash: {
			db,
			config: {
				auth: {
					type: "siteboulder",
					entrypoint: "@siteboulder/emdash-auth",
					config: { identityMode: "subject" },
				},
			},
			getPluginRouteMeta: vi.fn(() => ({ public: false })),
		},
	};
	const url = new URL("/blog/field-notes", "https://site-one.example.test");
	const session = { get: vi.fn(async () => null), set: vi.fn() };
	const response = await onRequest(
		{
			request: new Request(url),
			url,
			locals,
			session,
			cookies: { get: () => undefined },
			isPrerendered: false,
			redirect: vi.fn(),
		} as never,
		async () => new Response("page"),
	);
	return { response, locals, session };
}

async function userRows(db: Kysely<Database>) {
	return db.selectFrom("users").select(["id", "email", "name", "role", "disabled"]).execute();
}

describe("subject-based external authentication for platform-managed sites", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
		authenticate.mockReset();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	it("provisions the FIRST external user at their asserted Editor role, never Admin", async () => {
		const { response, locals } = await request(db, identity());
		expect(response.status).toBe(200);
		const [user] = await userRows(db);
		expect(user.role).toBe(40);
		expect((locals.user as { id: string }).id).toBe(user.id);
		const link = await db
			.selectFrom("oauth_accounts")
			.select(["provider", "provider_account_id", "user_id"])
			.executeTakeFirstOrThrow();
		expect(link).toEqual({
			provider: "external:siteboulder",
			provider_account_id: "siteboulder-user-1",
			user_id: user.id,
		});
	});

	it("tracks the subject across email changes and always synchronizes role downgrades", async () => {
		const first = await request(db, identity({ role: 50 }));
		expect(first.response.status).toBe(200);
		const [original] = await userRows(db);
		const updated = await request(
			db,
			identity({
				email: "renamed@example.test",
				name: "Renamed",
				role: 30,
			}),
			{ syncRoles: false },
		);
		expect(updated.response.status).toBe(200);
		const rows = await userRows(db);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({
			id: original.id,
			email: "renamed@example.test",
			name: "Renamed",
			role: 30,
		});
	});

	it("does not overwrite another user's email when the linked subject changes email", async () => {
		const now = new Date().toISOString();
		await db
			.insertInto("users")
			.values({
				id: "other-user",
				email: "taken@example.test",
				name: "Other User",
				role: 30,
				email_verified: 1,
				created_at: now,
				updated_at: now,
			})
			.execute();
		const first = await request(db, identity({ role: 40 }));
		expect(first.response.status).toBe(200);
		const change = await request(db, identity({ email: "taken@example.test", role: 50 }));
		expect(change.response.status).toBe(403);
		const user = (await userRows(db)).find((row) => row.email === "owner@example.test");
		expect(user).toMatchObject({ role: 40 });
		const [other] = await db
			.selectFrom("users")
			.selectAll()
			.where("id", "=", "other-user")
			.execute();
		expect(other.email).toBe("taken@example.test");
	});

	it("revalidates the managed provider before OAuth and device consent, never session-only", async () => {
		const oldSession = { get: vi.fn(async () => ({ user: { id: "old-session" } })), set: vi.fn() };
		const emdash = {
			db,
			config: {
				auth: {
					type: "siteboulder",
					entrypoint: "siteboulder/auth",
					config: { identityMode: "subject" },
				},
			},
		};
		for (const path of ["/_emdash/oauth/authorize", "/_emdash/api/oauth/device/authorize"]) {
			authenticate.mockRejectedValueOnce(new Error("membership revoked"));
			const url = new URL(path, "https://site-one.example.test");
			const locals: Record<string, unknown> = { emdash };
			const response = await onRequest(
				{
					request: new Request(url),
					url,
					locals,
					session: oldSession,
					redirect: vi.fn(),
				} as never,
				async () => new Response("would issue an OAuth code"),
			);
			expect(response.status).toBe(401);
			expect(locals.user).toBeUndefined();
		}
	});

	it("does not link another subject to an existing email, even if it asserts Admin", async () => {
		await request(db, identity());
		const attacker = await request(db, identity({ subject: "other-tenant-user", role: 50 }));
		expect(attacker.response.status).toBe(403);
		expect(attacker.locals.user).toBeUndefined();
		const [user] = await userRows(db);
		expect(user.role).toBe(40);
		expect(await db.selectFrom("oauth_accounts").selectAll().execute()).toHaveLength(1);
	});

	it("requires an explicit link to an existing passkey user with the same email", async () => {
		const now = new Date().toISOString();
		await db
			.insertInto("users")
			.values({
				id: "existing-passkey-admin",
				email: "owner@example.test",
				name: "Passkey Administrator",
				role: 50,
				email_verified: 1,
				created_at: now,
				updated_at: now,
			})
			.execute();
		const denied = await request(db, identity({ role: 30 }));
		expect(denied.response.status).toBe(403);
		expect(await userRows(db)).toHaveLength(1);

		// Provisioning must link this exact verified platform identity to the
		// existing CMS user by ID in a trusted migration, never by login email.
		await db
			.insertInto("oauth_accounts")
			.values({
				provider: "external:siteboulder",
				provider_account_id: "siteboulder-user-1",
				user_id: "existing-passkey-admin",
				created_at: now,
			})
			.execute();
		const allowed = await request(db, identity({ role: 30 }));
		expect(allowed.response.status).toBe(200);
		expect((await userRows(db))[0]).toMatchObject({
			id: "existing-passkey-admin",
			role: 30,
		});
	});

	it("respects disabled provisioning and rejects unsupported external roles", async () => {
		const denied = await request(db, identity({ role: 50 }), { autoProvision: false });
		expect(denied.response.status).toBe(403);
		expect(await userRows(db)).toHaveLength(0);

		const invalid = await request(db, identity({ role: 35 }));
		expect(invalid.response.status).toBe(503);
		expect(await userRows(db)).toHaveLength(0);
		expect(await db.selectFrom("oauth_accounts").selectAll().execute()).toHaveLength(0);
	});

	it("rejects a missing subject and never provisions an accidental Admin", async () => {
		for (const subject of [undefined, "", " ", "x".repeat(257)]) {
			const { response, locals } = await request(db, identity({ subject, role: 50 }));
			expect(response.status).toBe(401);
			expect(locals.user).toBeUndefined();
		}
		expect(await userRows(db)).toHaveLength(0);
	});

	it("preserves a disabled account even if the provider asserts a higher role", async () => {
		await request(db, identity({ role: 30 }));
		const [user] = await userRows(db);
		await db.updateTable("users").set({ disabled: 1 }).where("id", "=", user.id).execute();
		const { response, locals } = await request(db, identity({ role: 50 }));
		expect(response.status).toBe(403);
		expect(locals.user).toBeUndefined();
		expect((await userRows(db))[0]).toMatchObject({ disabled: 1, role: 30 });
	});

	it("rechecks subject and current membership for every locally-issued bearer token", async () => {
		await request(db, identity({ role: 50 }));
		const [user] = await userRows(db);
		const issued = await handleApiTokenCreate(db, user.id, {
			name: "test-local-token",
			scopes: ["admin"],
		});
		expect(issued.success).toBe(true);
		if (!issued.success) throw new Error("PAT creation failed");
		const token = issued.data.token;
		const url = new URL("/_emdash/api/admin/users", "https://site-one.example.test");
		const externalConfig = {
			auth: {
				type: "siteboulder",
				entrypoint: "siteboulder/auth",
				config: { identityMode: "subject" },
			},
		};
		async function tokenCall() {
			const locals: Record<string, unknown> = { emdash: { db, config: externalConfig } };
			const response = await onRequest(
				{
					request: new Request(url, { headers: { Authorization: "Bearer " + token } }),
					url,
					locals,
					session: { get: vi.fn(async () => null), set: vi.fn() },
					redirect: vi.fn(),
				} as never,
				async () => new Response("ok"),
			);
			return { response, locals };
		}

		// A PAT by itself is not sufficient for Site Boulder-managed CMS access.
		authenticate.mockRejectedValue(new Error("missing external assertion"));
		expect((await tokenCall()).response.status).toBe(401);

		// A fresh provider assertion is required and must match the PAT user.
		authenticate.mockResolvedValue(identity({ role: 40 }));
		const authorized = await tokenCall();
		expect(authorized.response.status).toBe(200);
		expect((authorized.locals.user as { id: string; role: number }).role).toBe(40);
		expect((await userRows(db))[0].role).toBe(40);

		// A *different* verified subject cannot reuse the old CMS PAT.
		authenticate.mockResolvedValue(identity({ subject: "other-member", role: 50 }));
		expect((await tokenCall()).response.status).toBe(401);

		// Membership revocation must invalidate the token even while it remains
		// stored as a valid local PAT.
		authenticate.mockRejectedValue(new Error("member removed"));
		expect((await tokenCall()).response.status).toBe(401);
		const stored = await db.selectFrom("_emdash_api_tokens").select("id").execute();
		expect(stored).toHaveLength(1);
	});

	it("honors current provider revocation even when a previous user session exists", async () => {
		await request(db, identity());
		authenticate.mockRejectedValueOnce(new Error("platform membership revoked"));
		const locals: Record<string, unknown> = {
			emdash: {
				db,
				config: {
					auth: {
						type: "siteboulder",
						entrypoint: "siteboulder/auth",
						config: { identityMode: "subject" },
					},
				},
				getPluginRouteMeta: vi.fn(() => ({ public: false })),
			},
		};
		const url = new URL("/_emdash/api/plugins/inquiries/list", "https://site-one.example.test");
		const response = await onRequest(
			{
				request: new Request(url),
				url,
				locals,
				session: { get: vi.fn(async () => ({ user: { id: "stale" } })), set: vi.fn() },
				redirect: vi.fn(),
			} as never,
			async () => new Response("ok"),
		);
		expect(response.status).toBe(401);
		expect(locals.user).toBeUndefined();
	});

	it("separates identical provider subjects in independent site databases", async () => {
		const secondDb = await setupTestDatabase();
		try {
			expect((await request(db, identity({ role: 50 }))).response.status).toBe(200);
			expect((await request(secondDb, identity({ role: 40 }))).response.status).toBe(200);
			const [one] = await userRows(db);
			const [two] = await userRows(secondDb);
			expect(one.role).toBe(50);
			expect(two.role).toBe(40);
			expect(one.id).not.toBe(two.id);
		} finally {
			await teardownTestDatabase(secondDb);
		}
	});

	it("redirects expired CMS browser sessions to a fixed trusted platform SSO URL", async () => {
		authenticate.mockRejectedValue(new Error("expired browser assertion"));
		const locals: Record<string, unknown> = {
			emdash: {
				db,
				config: {
					auth: {
						type: "siteboulder",
						entrypoint: "@siteboulder/emdash-auth",
						config: {
							identityMode: "subject",
							loginUrl: "https://siteboulder.com/api/sites/site-a/cms/login",
						},
					},
				},
			},
		};
		const browserUrl = new URL(
			"/_emdash/admin?next=https://evil.example.test",
			"https://site-a.example.test",
		);
		const context = {
			request: new Request(browserUrl),
			url: browserUrl,
			locals,
			session: { get: vi.fn(async () => null), set: vi.fn() },
			redirect: vi.fn(),
		};
		const redirected = await onRequest(context as never, async () => new Response("ok"));
		expect(redirected.status).toBe(302);
		expect(redirected.headers.get("Location")).toBe(
			"https://siteboulder.com/api/sites/site-a/cms/login",
		);
		expect(redirected.headers.get("Cache-Control")).toBe("private, no-store");

		// The same expired assertion must never redirect an API client.
		const apiUrl = new URL("/_emdash/api/admin/users", "https://site-a.example.test");
		const apiResult = await onRequest(
			{
				...context,
				request: new Request(apiUrl),
				url: apiUrl,
			} as never,
			async () => new Response("ok"),
		);
		expect(apiResult.status).toBe(401);
		expect(apiResult.headers.get("Location")).toBeNull();

		// An invalid/HTTP URL in trusted config also fails closed.
		const invalidContext = {
			...context,
			locals: {
				emdash: {
					...(locals.emdash as object),
					config: {
						auth: {
							type: "siteboulder",
							entrypoint: "@siteboulder/emdash-auth",
							config: { identityMode: "subject", loginUrl: "http://evil.example.test" },
						},
					},
				},
			},
		};
		const invalid = await onRequest(invalidContext as never, async () => new Response("ok"));
		expect(invalid.status).toBe(401);
	});

	it("identifies an already-linked editor on public pages for visual editing, never provisioning", async () => {
		await request(db, identity({ role: 40 }));
		const [linked] = await userRows(db);
		const page = await publicPage(db, identity({ role: 50 }));
		expect(await page.response.text()).toBe("page");
		expect((page.locals.user as { id: string; role: number }).id).toBe(linked.id);
		// The provider's current role applies to this request; nothing is written.
		expect((page.locals.user as { role: number }).role).toBe(50);
		expect((await userRows(db))[0].role).toBe(40);
		expect(page.session.set).not.toHaveBeenCalled();

		for (const visitor of [
			identity({ subject: "someone-else", email: "other@example.test" }),
			identity({ subject: "" }),
			new Error("No verified Site Boulder CMS identity"),
		]) {
			const anonymous = await publicPage(db, visitor);
			expect(await anonymous.response.text()).toBe("page");
			expect(anonymous.locals.user).toBeUndefined();
		}
		expect(await userRows(db)).toHaveLength(1);
		expect(await db.selectFrom("oauth_accounts").select("user_id").execute()).toHaveLength(1);

		// An unlinked subject asserting the linked user's email is not that user.
		expect((await publicPage(db, identity({ subject: "impostor" }))).locals.user).toBeUndefined();

		await db.updateTable("users").set({ disabled: 1 }).where("id", "=", linked.id).execute();
		expect((await publicPage(db, identity())).locals.user).toBeUndefined();
	});

	it("applies a provider downgrade on public pages and never falls back to the Astro session", async () => {
		await request(db, identity({ role: 50 }));
		const [linked] = await userRows(db);
		expect(linked.role).toBe(50);
		expect(
			((await publicPage(db, identity({ role: 40 }))).locals.user as { role: number }).role,
		).toBe(40);
		const { resolveSessionUser } = await import("../../../src/astro/session-user.js");
		vi.mocked(resolveSessionUser).mockResolvedValue({ id: linked.id } as never);
		try {
			const anonymous = await publicPage(db, new Error("No verified Site Boulder CMS identity"));
			expect(anonymous.locals.user).toBeUndefined();
		} finally {
			vi.mocked(resolveSessionUser).mockResolvedValue(null as never);
		}
	});

	it("never touches the Astro session on a site that keeps no session store", async () => {
		virtualConfig.sessionEnabled = false;
		try {
			authenticate.mockResolvedValue(identity());
			const locals: Record<string, unknown> = {
				emdash: {
					db,
					config: {
						auth: {
							type: "siteboulder",
							entrypoint: "@siteboulder/emdash-auth",
							config: { identityMode: "subject" },
						},
					},
					getPluginRouteMeta: vi.fn(() => ({ public: false })),
				},
			};
			const url = new URL("/_emdash/api/plugins/inquiries/list", "https://site-one.example.test");
			const context = { request: new Request(url), url, locals, redirect: vi.fn() };
			const read = vi.fn();
			Object.defineProperty(context, "session", { get: read });
			const response = await onRequest(context as never, async () => new Response("ok"));
			expect(response.status).toBe(200);
			expect((locals.user as { id: string }).id).toBeTruthy();
			expect(read).not.toHaveBeenCalled();
		} finally {
			delete virtualConfig.sessionEnabled;
		}
	});

	it("preserves the standalone legacy email-based first-user Admin default", async () => {
		const { response } = await request(db, identity({ subject: undefined, role: 30 }), {
			identityMode: "email",
		});
		expect(response.status).toBe(200);
		expect((await userRows(db))[0].role).toBe(50);
		expect(await db.selectFrom("oauth_accounts").selectAll().execute()).toHaveLength(0);
	});
});
