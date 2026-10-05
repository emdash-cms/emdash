// workerd can cancel pending work that was not handed to `waitUntil` once the
// response is out. The stand-in `waitUntil` collects what the middleware hands it.
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { getDbMock, handedToWaitUntil } = vi.hoisted(() => ({
	getDbMock: vi.fn(),
	handedToWaitUntil: [] as Promise<unknown>[],
}));

vi.mock("virtual:emdash/wait-until", () => ({
	waitUntil: (promise: Promise<unknown>) => {
		handedToWaitUntil.push(promise);
	},
}));

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
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

function buildContext(pathname: string): MiddlewareContext {
	const url = new URL(`https://example.com${pathname}`);
	const ctx = {
		url,
		request: new Request(url.toString()),
		locals: {},
		redirect: (location: string, status: number) =>
			new Response(null, { status, headers: { Location: location } }),
	};
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal Astro-shaped object for the middleware under test
	return ctx as unknown as MiddlewareContext;
}

const drainTasks = () => new Promise((resolve) => setTimeout(resolve, 0));

function createGate(): { opened: Promise<void>; open: () => void } {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => {
		open = resolve;
	});
	return { opened, open };
}

describe("redirect middleware bookkeeping writes", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		invalidateRedirectCache();
		db = await setupTestDatabase();
		const repo = new RedirectRepository(db);
		await repo.create({ source: "/old", destination: "/new", type: 301 });
		await repo.create({ source: "/gone", destination: "", type: 410 });
		await repo.create({ source: "/legacy/[slug]", destination: "/posts/[slug]", type: 301 });
		await repo.create({ source: "/archive/[slug]", destination: "", type: 410 });
		getDbMock.mockReset();
		getDbMock.mockResolvedValue(db);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	async function requestAndExpectInvocationHeldOpen(pathname: string, write: { open: () => void }) {
		handedToWaitUntil.length = 0;
		await onRequest(buildContext(pathname), async () => new Response(null, { status: 404 }));
		await drainTasks();

		try {
			const invocationEnded = vi.fn();
			void Promise.allSettled(handedToWaitUntil).then(invocationEnded);
			await drainTasks();
			expect(invocationEnded).not.toHaveBeenCalled();
		} finally {
			write.open();
			await Promise.allSettled(handedToWaitUntil);
		}
	}

	it.each([
		{ label: "an exact redirect", pathname: "/old", source: "/old" },
		{ label: "an exact 410 rule", pathname: "/gone", source: "/gone" },
		{ label: "a pattern redirect", pathname: "/legacy/hello", source: "/legacy/[slug]" },
		{ label: "a pattern 410 rule", pathname: "/archive/hello", source: "/archive/[slug]" },
	])("counts the hit on $label before the invocation ends", async ({ pathname, source }) => {
		const write = createGate();
		const recordHit = RedirectRepository.prototype.recordHit;
		vi.spyOn(RedirectRepository.prototype, "recordHit").mockImplementation(async function (
			this: RedirectRepository,
			id: string,
		) {
			await write.opened;
			return recordHit.call(this, id);
		});

		await requestAndExpectInvocationHeldOpen(pathname, write);

		const row = await db
			.selectFrom("_emdash_redirects")
			.select("hits")
			.where("source", "=", source)
			.executeTakeFirstOrThrow();
		expect(row.hits).toBe(1);
	});

	it("logs a 404 before the invocation ends", async () => {
		const write = createGate();
		const log404 = RedirectRepository.prototype.log404;
		vi.spyOn(RedirectRepository.prototype, "log404").mockImplementation(
			async function (this: RedirectRepository, entry) {
				await write.opened;
				return log404.call(this, entry);
			},
		);

		await requestAndExpectInvocationHeldOpen("/no-such-page", write);

		const rows = await db.selectFrom("_emdash_404_log").select("path").execute();
		expect(rows.map((r) => r.path)).toEqual(["/no-such-page"]);
	});
});
