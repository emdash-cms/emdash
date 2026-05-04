/**
 * Regression tests for issue #808: redirect middleware silently no-oped for
 * unauthenticated public visitors because `locals.emdash.db` is intentionally
 * absent on the public-visitor branch of runtime init. The fix routes the
 * lookup through `getDb()` (ALS-aware, falls back to singleton).
 */
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { getDbMock } = vi.hoisted(() => ({
	getDbMock: vi.fn(),
}));

vi.mock("../../../src/loader.js", () => ({
	getDb: getDbMock,
}));

import { onRequest } from "../../../src/astro/middleware/redirect.js";
import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import type { Database } from "../../../src/database/types.js";
import { invalidateRedirectCache } from "../../../src/redirects/cache.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

type MiddlewareContext = Parameters<typeof onRequest>[0];

interface BuildContextOpts {
	pathname: string;
	emdashDb?: unknown;
}

function buildContext({ pathname, emdashDb }: BuildContextOpts): {
	context: MiddlewareContext;
	redirect: ReturnType<typeof vi.fn>;
} {
	const redirect = vi.fn(
		(location: string, status: number) =>
			new Response(null, { status, headers: { Location: location } }),
	);
	const url = new URL(`https://example.com${pathname}`);
	const locals = emdashDb !== undefined ? { emdash: { db: emdashDb } } : {};
	const ctx = {
		url,
		request: new Request(url.toString()),
		locals,
		redirect,
	};
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- minimal Astro-shaped object for the middleware under test
	return { context: ctx as unknown as MiddlewareContext, redirect };
}

describe("redirect middleware — issue #808", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		invalidateRedirectCache();
		db = await setupTestDatabase();
		const repo = new RedirectRepository(db);
		await repo.create({ source: "/old", destination: "/new", type: 301 });
		await repo.create({
			source: "/legacy/[slug]",
			destination: "/posts/[slug]",
			type: 301,
			isPattern: true,
		});
		getDbMock.mockReset();
		getDbMock.mockResolvedValue(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	async function runMiddleware(
		context: MiddlewareContext,
		next: () => Promise<Response>,
	): Promise<Response> {
		const result = await onRequest(context, next);
		if (!(result instanceof Response)) {
			throw new Error("Middleware returned void; expected a Response");
		}
		return result;
	}

	it("fires for an unauthenticated visitor on a public path (no locals.emdash.db)", async () => {
		const { context, redirect } = buildContext({ pathname: "/old" });

		const next = vi.fn(async () => new Response("not found", { status: 404 }));
		const response = await runMiddleware(context, next);

		expect(getDbMock).toHaveBeenCalledTimes(1);
		expect(redirect).toHaveBeenCalledWith("/new", 301);
		expect(response.status).toBe(301);
		expect(response.headers.get("Location")).toBe("/new");
		expect(next).not.toHaveBeenCalled();
	});

	it("fires pattern matches for unauthenticated visitors", async () => {
		const { context, redirect } = buildContext({ pathname: "/legacy/hello" });

		const next = vi.fn(async () => new Response("not found", { status: 404 }));
		const response = await runMiddleware(context, next);

		expect(redirect).toHaveBeenCalledWith("/posts/hello", 301);
		expect(response.status).toBe(301);
	});

	it("still uses locals.emdash.db when present (authenticated/edit-mode/preview path)", async () => {
		const { context, redirect } = buildContext({ pathname: "/old", emdashDb: db });

		const next = vi.fn(async () => new Response("not found", { status: 404 }));
		const response = await runMiddleware(context, next);

		// When locals.emdash.db is provided, getDb() must not be called.
		expect(getDbMock).not.toHaveBeenCalled();
		expect(redirect).toHaveBeenCalledWith("/new", 301);
		expect(response.status).toBe(301);
	});

	it("skips silently when no database is available at all", async () => {
		getDbMock.mockRejectedValueOnce(new Error("EmDash database not configured"));
		const { context, redirect } = buildContext({ pathname: "/old" });

		const next = vi.fn(async () => new Response("ok"));
		const response = await runMiddleware(context, next);

		expect(redirect).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledTimes(1);
		expect(response.status).toBe(200);
	});

	it("warms the redirect cache from one query and reuses it across requests", async () => {
		const findAllEnabled = vi.spyOn(RedirectRepository.prototype, "findAllEnabled");

		// First request: cache cold, should issue exactly one query.
		const first = buildContext({ pathname: "/old" });
		const next1 = vi.fn(async () => new Response("not found", { status: 404 }));
		const r1 = await runMiddleware(first.context, next1);
		expect(r1.status).toBe(301);
		expect(findAllEnabled).toHaveBeenCalledTimes(1);

		// Second request (exact match): cache warm, no further queries.
		const second = buildContext({ pathname: "/old" });
		const next2 = vi.fn(async () => new Response("not found", { status: 404 }));
		const r2 = await runMiddleware(second.context, next2);
		expect(r2.status).toBe(301);
		expect(findAllEnabled).toHaveBeenCalledTimes(1);

		// Third request (pattern match): still warm, no further queries.
		const third = buildContext({ pathname: "/legacy/hello" });
		const next3 = vi.fn(async () => new Response("not found", { status: 404 }));
		const r3 = await runMiddleware(third.context, next3);
		expect(r3.status).toBe(301);
		expect(third.redirect).toHaveBeenCalledWith("/posts/hello", 301);
		expect(findAllEnabled).toHaveBeenCalledTimes(1);

		// Fourth request (no match): still warm, but next() runs and a 404 is logged.
		const fourth = buildContext({ pathname: "/nope" });
		const next4 = vi.fn(async () => new Response("not found", { status: 404 }));
		await runMiddleware(fourth.context, next4);
		expect(findAllEnabled).toHaveBeenCalledTimes(1);

		findAllEnabled.mockRestore();
	});

	it("does not intercept /_emdash routes", async () => {
		const { context, redirect } = buildContext({ pathname: "/_emdash/admin" });

		const next = vi.fn(async () => new Response("ok"));
		await runMiddleware(context, next);

		expect(getDbMock).not.toHaveBeenCalled();
		expect(redirect).not.toHaveBeenCalled();
		expect(next).toHaveBeenCalledTimes(1);
	});
});
