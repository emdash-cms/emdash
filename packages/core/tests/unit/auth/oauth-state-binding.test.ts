import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter, type AuthTables } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OptionsRepository } from "../../../src/database/repositories/options.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

const ENV = {
	EMDASH_OAUTH_GITHUB_CLIENT_ID: "client-id",
	EMDASH_OAUTH_GITHUB_CLIENT_SECRET: "client-secret",
};

const STATE_COOKIE_PREFIX = "emdash_oauth_state_";

function redirect(url: string): Response {
	return new Response(null, { status: 302, headers: { Location: url } });
}

/** The parts of an Astro context that belong to one browser. */
function browser() {
	const jar = new Map<string, string>();
	const options = new Map<string, Record<string, unknown>>();
	return {
		jar,
		options,
		context: {
			cookies: {
				get: (name: string) => (jar.has(name) ? { value: jar.get(name) } : undefined),
				set: (name: string, value: string, opts: Record<string, unknown>) => {
					jar.set(name, value);
					options.set(name, opts);
				},
				delete: (name: string) => jar.delete(name),
			},
			session: { set: vi.fn(), regenerate: vi.fn(async () => {}) },
		},
	};
}

type Browser = ReturnType<typeof browser>;

function stateCookieOptions(b: Browser): Record<string, unknown> | undefined {
	const name = [...b.options.keys()].find((key) => key.startsWith(STATE_COOKIE_PREFIX));
	return name ? b.options.get(name) : undefined;
}

function stateCookieCount(b: Browser): number {
	return [...b.jar.keys()].filter((key) => key.startsWith(STATE_COOKIE_PREFIX)).length;
}

describe("OAuth sign-in completes only in the browser that started it", () => {
	let db: Kysely<Database>;
	let memberId: string;

	beforeEach(async () => {
		db = await setupTestDatabase();
		await new OptionsRepository(db).set("emdash:setup_complete", true);
		const adapter = createKyselyAdapter(db as unknown as Kysely<AuthTables>);
		const member = await adapter.createUser({
			email: "member@example.com",
			role: Role.CONTRIBUTOR,
			emailVerified: true,
		});
		memberId = member.id;
		vi.stubGlobal(
			"fetch",
			vi.fn(async (input: RequestInfo | URL) => {
				const url = input instanceof Request ? input.url : String(input);
				if (url === "https://github.com/login/oauth/access_token") {
					return Response.json({ access_token: "access-token" });
				}
				if (url === "https://api.github.com/user") {
					return Response.json({
						id: 1,
						login: "member",
						name: "Member",
						email: "member@example.com",
						avatar_url: "https://avatars.githubusercontent.com/u/1",
					});
				}
				throw new Error(`Unexpected fetch: ${url}`);
			}),
		);
	});

	afterEach(async () => {
		vi.unstubAllGlobals();
		vi.doUnmock("virtual:emdash/env");
		vi.resetModules();
		await teardownTestDatabase(db);
	});

	async function loadRoutes() {
		vi.resetModules();
		vi.doMock("virtual:emdash/env", () => ({ env: ENV }));
		const start = await import("../../../src/astro/routes/api/auth/oauth/[provider].js");
		const callback =
			await import("../../../src/astro/routes/api/auth/oauth/[provider]/callback.js");
		return { start: start.GET, callback: callback.GET };
	}

	/** Starts a sign-in in `from` and returns the callback URL the provider would redirect to. */
	async function startSignIn(from: Browser, origin = "http://localhost:4321"): Promise<string> {
		const { start } = await loadRoutes();
		const started = await start({
			params: { provider: "github" },
			request: new Request(`${origin}/_emdash/api/auth/oauth/github`),
			locals: { emdash: { db, config: {} } },
			redirect,
			...from.context,
		} as unknown as Parameters<typeof start>[0]);
		const state = new URL(started.headers.get("Location") ?? "").searchParams.get("state");
		return `${origin}/_emdash/api/auth/oauth/github/callback?code=auth-code&state=${state}`;
	}

	/** Opens a callback URL in `into`; returns where the site redirects. */
	async function openCallback(into: Browser, callbackUrl: string): Promise<string> {
		const { callback } = await loadRoutes();
		const finished = await callback({
			params: { provider: "github" },
			request: new Request(callbackUrl),
			locals: { emdash: { db, config: {} } },
			redirect,
			...into.context,
		} as unknown as Parameters<typeof callback>[0]);
		return finished.headers.get("Location") ?? "";
	}

	it("signs in the browser that started the sign-in", async () => {
		const own = browser();

		expect(await openCallback(own, await startSignIn(own))).toBe("/_emdash/admin");
		expect(own.context.session.set).toHaveBeenCalledWith("user", { id: memberId });
		expect(stateCookieCount(own)).toBe(0);
	});

	it("refuses a callback URL opened in a browser that started no sign-in", async () => {
		const other = browser();
		const opener = browser();

		const location = await openCallback(opener, await startSignIn(other));

		expect(location).toContain("error=invalid_state");
		expect(opener.context.session.set).not.toHaveBeenCalled();
	});

	it("refuses a callback URL from another browser's sign-in without using up either one", async () => {
		const other = browser();
		const opener = browser();
		const otherCallback = await startSignIn(other);
		const ownCallback = await startSignIn(opener);

		expect(await openCallback(opener, otherCallback)).toContain("error=invalid_state");
		expect(opener.context.session.set).not.toHaveBeenCalled();

		expect(await openCallback(opener, ownCallback)).toBe("/_emdash/admin");
		expect(await openCallback(other, otherCallback)).toBe("/_emdash/admin");
	});

	it("finishes several sign-ins started in the same browser", async () => {
		const own = browser();
		const first = await startSignIn(own);
		const second = await startSignIn(own);

		expect(await openCallback(own, first)).toBe("/_emdash/admin");
		expect(await openCallback(own, second)).toBe("/_emdash/admin");
		expect(stateCookieCount(own)).toBe(0);
	});

	it("refuses a state that is not shaped like one EmDash issues", async () => {
		const own = browser();
		await startSignIn(own);

		const location = await openCallback(
			own,
			"http://localhost:4321/_emdash/api/auth/oauth/github/callback?code=auth-code&state=a%3Bb",
		);

		expect(location).toContain("error=invalid_state");
		expect(own.context.session.set).not.toHaveBeenCalled();
	});

	it("keeps the state cookie away from scripts and sends it over https only on an https site", async () => {
		const plain = browser();
		await startSignIn(plain);
		expect(stateCookieOptions(plain)).toMatchObject({
			httpOnly: true,
			secure: false,
			sameSite: "lax",
			path: "/_emdash/api/auth/oauth/",
		});

		const tls = browser();
		await startSignIn(tls, "https://cms.example.com");
		expect(stateCookieOptions(tls)).toMatchObject({ httpOnly: true, secure: true });
	});
});
