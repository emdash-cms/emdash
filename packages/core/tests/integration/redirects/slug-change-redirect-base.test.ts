import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

import {
	handleContentCreate,
	handleContentPublish,
	handleContentUpdate,
} from "../../../src/api/handlers/content.js";
import { onRequest } from "../../../src/astro/middleware/redirect.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { Database } from "../../../src/database/types.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import { publishRedirectArtifacts } from "../../../src/redirects/artifacts.js";
import { invalidateRedirectCache } from "../../../src/redirects/cache.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const BASES = ["/", "/blog", "/blog/", "/site/blog/"];
const PATTERNS = ["/posts/{slug}", "/posts/{slug}/"];

type MiddlewareContext = Parameters<typeof onRequest>[0];

function middlewareContext(db: Kysely<Database>, pathname: string) {
	const url = new URL(`https://example.test${pathname}`);
	const redirect = vi.fn(
		(location: string, status: number) =>
			new Response(null, { status, headers: { Location: location } }),
	);
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal Astro context for the middleware
	const context = {
		url,
		request: new Request(url),
		locals: { emdash: { db } },
		redirect,
		cache: { set: vi.fn() },
	} as unknown as MiddlewareContext;
	return { context, redirect };
}

function withBase(base: string, path: string): string {
	const prefix = base === "/" ? "" : base.replace(/\/$/, "");
	return `${prefix}${path}`;
}

describeEachDialect("slug-change redirects with Astro base", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	describe.each(PATTERNS)("URL pattern %s", (urlPattern) => {
		beforeEach(async () => {
			ctx = await setupForDialect(dialect);
			db = ctx.db;
			const schema = new SchemaRegistry(db);
			await schema.createCollection({ slug: "posts", label: "Posts", urlPattern });
			await schema.createField("posts", { slug: "title", label: "Title", type: "string" });
		});

		afterEach(async () => {
			await waitForDeferredTasks();
			await teardownForDialect(ctx);
			vi.unstubAllEnvs();
			invalidateRedirectCache();
		});

		async function published(slug: string) {
			return new ContentRepository(db).create({
				type: "posts",
				slug,
				status: "published",
				data: { title: slug },
			});
		}

		async function request(pathname: string) {
			const result = middlewareContext(db, pathname);
			const response = await onRequest(
				result.context,
				async () => new Response("missing", { status: 404 }),
			);
			if (!(response instanceof Response)) throw new Error("Expected a middleware response");
			return { ...result, response };
		}

		it.each(BASES)("redirects the full old URL for base %s", async (base) => {
			vi.stubEnv("BASE_URL", base);
			const entry = await published("old");
			await expect(
				handleContentUpdate(db, "posts", entry.id, { slug: "new" }),
			).resolves.toMatchObject({
				success: true,
			});
			await publishRedirectArtifacts(db);
			invalidateRedirectCache();

			const oldPath = withBase(base, urlPattern.replace("{slug}", "old"));
			const newPath = withBase(base, urlPattern.replace("{slug}", "new"));
			const result = await request(oldPath);
			expect(result.response.status).toBe(301);
			expect(result.response.headers.get("Location")).toBe(newPath);
			if (base !== "/") {
				const baseFree = await request(urlPattern.replace("{slug}", "old"));
				expect(baseFree.response.status).toBe(404);
			}
		});

		it("redirects a slug staged in a revision when it is published", async () => {
			vi.stubEnv("BASE_URL", "/blog");
			await new SchemaRegistry(db).updateCollection("posts", { supports: ["revisions"] });
			const entry = await published("old");
			const revision = await new RevisionRepository(db).create({
				collection: "posts",
				entryId: entry.id,
				data: { title: "New title", _slug: "new" },
			});
			await new ContentRepository(db).setDraftRevision("posts", entry.id, revision.id);
			await expect(handleContentPublish(db, "posts", entry.id)).resolves.toMatchObject({
				success: true,
			});
			await publishRedirectArtifacts(db);
			invalidateRedirectCache();
			const { response } = await request(withBase("/blog", urlPattern.replace("{slug}", "old")));
			expect(response.status).toBe(301);
			expect(response.headers.get("Location")).toBe(
				withBase("/blog", urlPattern.replace("{slug}", "new")),
			);
		});

		it.each(BASES)("collapses chains and handles a rename revert with base %s", async (base) => {
			vi.stubEnv("BASE_URL", base);
			const entry = await published("old");
			await handleContentUpdate(db, "posts", entry.id, { slug: "middle" });
			await handleContentUpdate(db, "posts", entry.id, { slug: "new" });
			const redirects = new RedirectRepository(db);
			await expect(
				redirects.findBySource(withBase(base, urlPattern.replace("{slug}", "old"))),
			).resolves.toMatchObject({
				destination: withBase(base, urlPattern.replace("{slug}", "new")),
			});

			await handleContentUpdate(db, "posts", entry.id, { slug: "old" });
			await expect(
				redirects.findBySource(withBase(base, urlPattern.replace("{slug}", "old"))),
			).resolves.toBeNull();
			await publishRedirectArtifacts(db);
			invalidateRedirectCache();
			const reverted = await request(withBase(base, urlPattern.replace("{slug}", "new")));
			expect(reverted.response.status).toBe(301);
			expect(reverted.response.headers.get("Location")).toBe(
				withBase(base, urlPattern.replace("{slug}", "old")),
			);
		});

		it.each(BASES)(
			"removes only the shadowing auto rule when publishing an old slug (%s)",
			async (base) => {
				vi.stubEnv("BASE_URL", base);
				const entry = await published("old");
				await handleContentUpdate(db, "posts", entry.id, { slug: "new" });
				const oldPath = withBase(base, urlPattern.replace("{slug}", "old"));
				await expect(new RedirectRepository(db).findBySource(oldPath)).resolves.toMatchObject({
					auto: true,
				});
				const manualSource = withBase(base, urlPattern.replace("{slug}", "manual"));
				await new RedirectRepository(db).create({
					source: manualSource,
					destination: "/manual-target",
				});
				const draft = await new ContentRepository(db).create({
					type: "posts",
					slug: "old",
					status: "draft",
					data: { title: "Replacement" },
				});
				await expect(handleContentPublish(db, "posts", draft.id)).resolves.toMatchObject({
					success: true,
				});
				await expect(
					handleContentCreate(db, "posts", {
						slug: "manual",
						status: "published",
						data: { title: "Manual" },
					}),
				).resolves.toMatchObject({ success: true });
				await publishRedirectArtifacts(db);
				invalidateRedirectCache();
				const manual = await request(manualSource);
				expect(manual.response.status).toBe(301);
				expect(manual.response.headers.get("Location")).toBe("/manual-target");

				expect(
					await new RedirectRepository(db).findBySource(
						withBase(base, urlPattern.replace("{slug}", "old")),
					),
				).toBeNull();
				expect(await new RedirectRepository(db).findBySource(manualSource)).toMatchObject({
					destination: "/manual-target",
					auto: false,
				});
			},
		);
	});
});
