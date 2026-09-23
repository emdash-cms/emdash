import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

import {
	onRequest,
	siteWriteFenceScope,
} from "../../../src/astro/middleware/media-usage-write-fence.js";
import type { Database } from "../../../src/database/types.js";
import { TransferOperationRepository } from "../../../src/transfer/ops/operations.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const FENCED_WRITES: Array<[string, string]> = [
	["POST", "/_emdash/api/content/posts"],
	["PUT", "/_emdash/api/content/posts/01ABC"],
	["DELETE", "/_emdash/api/content/posts/01ABC"],
	["POST", "/_emdash/api/schema/collections"],
	["POST", "/_emdash/api/media"],
	["POST", "/_emdash/api/media/upload-url"],
	["PUT", "/_emdash/api/menus/main"],
	["POST", "/_emdash/api/taxonomies/category/terms"],
	["POST", "/_emdash/api/sections"],
	["POST", "/_emdash/api/widget-areas/sidebar/widgets"],
	["POST", "/_emdash/api/redirects"],
	["POST", "/_emdash/api/relations"],
	["POST", "/_emdash/api/revisions/01ABC/restore"],
	["POST", "/_emdash/api/settings"],
	["POST", "/_emdash/api/search/rebuild"],
	["POST", "/_emdash/api/import/wordpress/execute"],
	["POST", "/_emdash/api/plugins/forms/submit"],
	["POST", "/_emdash/api/visual-editing/content/posts/01ABC/publish"],
	["POST", "/_emdash/api/themes/preview"],
	["POST", "/_emdash/api/setup"],
	["POST", "/_emdash/api/comments/posts/01ABC"],
	["POST", "/_emdash/api/comments/posts/01ABC/reactions"],
	["POST", "/_emdash/api/admin/bylines"],
	["POST", "/_emdash/api/admin/byline-fields"],
	["PUT", "/_emdash/api/admin/comments/01ABC/status"],
	["POST", "/_emdash/api/admin/media-usage/activation"],
	["POST", "/_emdash/api/admin/plugins/forms/settings"],
	["PUT", "/_emdash/api/admin/hooks/exclusive/content:beforeSave"],
	["DELETE", "/_emdash/api/admin/scheduled-policy-rejections/posts/01ABC"],
	["POST", "/_EMDASH/API/CONTENT/posts"],
	["POST", "/_emdash/api/%63ontent/posts"],
	["POST", "/_emdash/api/content/posts/"],
];

const UNFENCED_WRITES: Array<[string, string]> = [
	["POST", "/_emdash/api/admin/transfer/imports"],
	["PUT", "/_emdash/api/admin/transfer/imports/01ABC/files/manifest.json"],
	["POST", "/_emdash/api/admin/transfer/imports/01ABC/abandon"],
	["POST", "/_emdash/api/auth/logout"],
	["POST", "/_emdash/api/auth/passkey/verify"],
	["POST", "/_emdash/api/oauth/token"],
	["PUT", "/_emdash/api/admin/users/01ABC"],
	["POST", "/_emdash/api/admin/api-tokens"],
	["POST", "/_emdash/api/admin/oauth-clients"],
	["POST", "/_emdash/api/admin/allowed-domains"],
	["POST", "/_emdash/api/setup/dev-bypass"],
	["POST", "/_emdash/api/typegen"],
	["POST", "/_emdash/api/mcp"],
	["POST", "/some/site/page"],
];

/** Plugin lifecycle routes check the fence themselves; the middleware only records their writes. */
const ROUTE_CHECKED_WRITES: Array<[string, string]> = [
	["POST", "/_emdash/api/admin/plugins/forms/enable"],
	["POST", "/_emdash/api/admin/plugins/registry/install"],
];

/** Entry edit locks coordinate editors; they are neither import-fenced nor export writes. */
const ENTRY_LOCK_WRITES: Array<[string, string]> = [
	["POST", "/_emdash/api/content/posts/01ABC/lock"],
	["DELETE", "/_emdash/api/content/posts/01ABC/lock"],
];

describe("siteWriteFenceScope", () => {
	it.each(["GET", "HEAD", "OPTIONS"])("never fences %s", (method) => {
		expect(siteWriteFenceScope(method, "/_emdash/api/content/posts")).toBeNull();
		expect(siteWriteFenceScope(method, "/_emdash/api/comments/posts/01ABC")).toBeNull();
	});

	it.each(FENCED_WRITES)("fences %s %s for transfer imports", (method, pathname) => {
		expect(siteWriteFenceScope(method, pathname)?.transfer).toBe(true);
	});

	it.each(UNFENCED_WRITES)("does not fence %s %s", (method, pathname) => {
		expect(siteWriteFenceScope(method, pathname)).toBeNull();
	});

	it("applies the media usage fence only to its original paths", () => {
		expect(siteWriteFenceScope("POST", "/_emdash/api/content/posts")).toEqual({
			transfer: true,
			mediaUsage: true,
			recordWrite: true,
		});
		expect(siteWriteFenceScope("POST", "/_emdash/api/media")).toEqual({
			transfer: true,
			mediaUsage: false,
			recordWrite: true,
		});
	});

	it.each(ROUTE_CHECKED_WRITES)("only records %s %s", (method, pathname) => {
		expect(siteWriteFenceScope(method, pathname)).toEqual({
			transfer: false,
			mediaUsage: false,
			recordWrite: true,
		});
	});

	it.each(ENTRY_LOCK_WRITES)("exempts %s %s from imports and exports", (method, pathname) => {
		expect(siteWriteFenceScope(method, pathname)).toEqual({
			transfer: false,
			mediaUsage: true,
			recordWrite: false,
		});
	});

	it("ignores trailing slashes", () => {
		expect(siteWriteFenceScope("POST", "/_emdash/api/content/posts///")).toEqual(
			siteWriteFenceScope("POST", "/_emdash/api/content/posts"),
		);
		expect(siteWriteFenceScope("POST", "/_emdash/api/admin/transfer/")).toBeNull();
	});

	it("classifies a path with a long run of slashes in linear time", () => {
		const pathname = `/_emdash/api/content${"/".repeat(100_000)}x`;
		const started = performance.now();
		expect(siteWriteFenceScope("POST", pathname)?.transfer).toBe(true);
		expect(performance.now() - started).toBeLessThan(250);
	});
});

describeEachDialect("site write fence middleware", (dialect) => {
	let ctx: DialectTestContext;
	let queries: number;
	let counted: Kysely<Database>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		queries = 0;
		counted = ctx.db.withPlugin({
			transformQuery(args) {
				queries++;
				return args.node;
			},
			async transformResult(args) {
				return args.result;
			},
		});
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function operationInState(
		kind: "import" | "export",
		state: string,
		mutationStarted = false,
	): Promise<string> {
		const { operation } = await new TransferOperationRepository(ctx.db).create({
			kind,
			createdBy: "admin-1",
		});
		await ctx.db
			.updateTable("_emdash_transfer_operations")
			.set({ state, mutation_started_at: mutationStarted ? "2026-01-01T00:00:00.000Z" : null })
			.where("id", "=", operation.id)
			.execute();
		return operation.id;
	}

	async function writeEpoch(id: string): Promise<number> {
		const row = await ctx.db
			.selectFrom("_emdash_transfer_operations")
			.select("write_epoch")
			.where("id", "=", id)
			.executeTakeFirstOrThrow();
		return Number(row.write_epoch);
	}

	function invoke(
		method: string,
		pathname: string,
		next: () => Promise<Response> = async () => new Response(null, { status: 204 }),
	): Promise<Response> {
		const url = new URL(pathname, "https://example.com");
		return onRequest(
			{
				request: new Request(url, { method }),
				url,
				locals: { emdash: { db: counted } },
			} as never,
			next,
		) as Promise<Response>;
	}

	it("rejects fenced writes, including public comment posts, while an import runs", async () => {
		await operationInState("import", "running", true);
		for (const [method, pathname] of FENCED_WRITES) {
			const next = vi.fn(async () => new Response(null, { status: 204 }));
			const response = await invoke(method, pathname, next);
			expect(response.status, `${method} ${pathname}`).toBe(503);
			expect(await response.json()).toEqual({
				success: false,
				error: {
					code: "TRANSFER_IMPORT_IN_PROGRESS",
					message: "A site import is in progress or incomplete; writes are disabled",
				},
			});
			expect(next).not.toHaveBeenCalled();
		}
	});

	it("keeps fencing after a failed import that started writing, until abandoned", async () => {
		const id = await operationInState("import", "failed", true);
		expect((await invoke("POST", "/_emdash/api/content/posts")).status).toBe(503);
		await new TransferOperationRepository(ctx.db).abandon(id);
		expect((await invoke("POST", "/_emdash/api/content/posts")).status).toBe(204);
	});

	it("does not fence reads or exempt writes, and reads never query the fence", async () => {
		await operationInState("import", "running", true);
		queries = 0;
		for (const method of ["GET", "HEAD", "OPTIONS"]) {
			expect((await invoke(method, "/_emdash/api/content/posts")).status).toBe(204);
			expect((await invoke(method, "/_emdash/api/comments/posts/01ABC")).status).toBe(204);
		}
		expect(queries).toBe(0);
		for (const [method, pathname] of UNFENCED_WRITES) {
			expect((await invoke(method, pathname)).status, `${method} ${pathname}`).toBe(204);
		}
		expect(queries).toBe(0);
	});

	it("allows writes before an import starts writing", async () => {
		await operationInState("import", "planned");
		expect((await invoke("POST", "/_emdash/api/content/posts")).status).toBe(204);
	});

	it("checks both fences with one query and records nothing when no export runs", async () => {
		const exportId = await operationInState("export", "complete");
		queries = 0;
		expect((await invoke("POST", "/_emdash/api/content/posts")).status).toBe(204);
		expect(queries).toBe(1);
		expect(await writeEpoch(exportId)).toBe(0);
	});

	it("records a fenced write for a running export after the write", async () => {
		const exportId = await operationInState("export", "running");
		let epochDuringWrite = -1;
		queries = 0;
		const response = await invoke("POST", "/_emdash/api/content/posts", async () => {
			epochDuringWrite = await writeEpoch(exportId);
			return new Response(null, { status: 201 });
		});
		expect(response.status).toBe(201);
		expect(epochDuringWrite).toBe(0);
		expect(await writeEpoch(exportId)).toBe(1);
		expect(queries).toBe(2);

		await invoke("GET", "/_emdash/api/content/posts");
		await invoke("POST", "/_emdash/api/auth/logout");
		expect(await writeEpoch(exportId)).toBe(1);
	});

	it("records only writes that succeed", async () => {
		const exportId = await operationInState("export", "running");
		for (const status of [400, 403, 409, 500, 503]) {
			const response = await invoke(
				"POST",
				"/_emdash/api/content/posts",
				async () => new Response(null, { status }),
			);
			expect(response.status).toBe(status);
		}
		await expect(
			invoke("POST", "/_emdash/api/content/posts", async () => {
				throw new Error("write failed");
			}),
		).rejects.toThrow("write failed");
		expect(await writeEpoch(exportId)).toBe(0);
		expect((await invoke("PUT", "/_emdash/api/content/posts/01ABC")).status).toBe(204);
		expect(await writeEpoch(exportId)).toBe(1);
	});

	it("lets editors take and release entry locks during an import and never records them", async () => {
		const exportId = await operationInState("export", "running");
		const importId = await operationInState("import", "running", true);
		for (const [method, pathname] of ENTRY_LOCK_WRITES) {
			expect((await invoke(method, pathname)).status, `${method} ${pathname}`).toBe(204);
		}
		await ctx.db
			.updateTable("_emdash_transfer_operations")
			.set({ state: "failed" })
			.where("id", "=", importId)
			.execute();
		for (const [method, pathname] of ENTRY_LOCK_WRITES) {
			expect((await invoke(method, pathname)).status, `${method} ${pathname}`).toBe(204);
		}
		expect(await writeEpoch(exportId)).toBe(0);
	});

	it("records successful plugin lifecycle writes without reading the fence", async () => {
		const exportId = await operationInState("export", "running");
		queries = 0;
		for (const [method, pathname] of ROUTE_CHECKED_WRITES) {
			await invoke(method, pathname, async () => new Response(null, { status: 409 }));
		}
		expect(queries).toBe(0);
		expect(await writeEpoch(exportId)).toBe(0);
		for (const [method, pathname] of ROUTE_CHECKED_WRITES) {
			expect((await invoke(method, pathname)).status).toBe(204);
		}
		expect(queries).toBe(ROUTE_CHECKED_WRITES.length);
		expect(await writeEpoch(exportId)).toBe(ROUTE_CHECKED_WRITES.length);
	});

	it("keeps the media usage fence on its paths only", async () => {
		await ctx.db
			.updateTable("_emdash_media_usage_activation")
			.set({ state: "activating" })
			.where("task_key", "=", "incremental_capture")
			.execute();
		const blocked = await invoke("POST", "/_emdash/api/content/posts");
		expect(blocked.status).toBe(503);
		expect(((await blocked.json()) as { error: { code: string } }).error.code).toBe(
			"MEDIA_USAGE_ACTIVATION_IN_PROGRESS",
		);
		expect((await invoke("POST", "/_emdash/api/media")).status).toBe(204);
		expect((await invoke("POST", "/_emdash/api/comments/posts/01ABC")).status).toBe(204);
	});
});
