import { Role } from "@emdash-cms/auth";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	exportParamsDigest,
	handleExportCreate,
	handleImportExecute,
	requestTransferApproval,
} from "../../../src/api/handlers/transfer.js";
import { POST as approvePost } from "../../../src/astro/routes/api/admin/transfer/approvals/[id]/approve.js";
import { POST as denyPost } from "../../../src/astro/routes/api/admin/transfer/approvals/[id]/deny.js";
import { GET as approvalsGet } from "../../../src/astro/routes/api/admin/transfer/approvals/index.js";
import { GET as capabilitiesGet } from "../../../src/astro/routes/api/admin/transfer/capabilities.js";
import { POST as exportAdvancePost } from "../../../src/astro/routes/api/admin/transfer/exports/[id]/advance.js";
import { GET as exportArchiveGet } from "../../../src/astro/routes/api/admin/transfer/exports/[id]/archive.js";
import { GET as exportFileGet } from "../../../src/astro/routes/api/admin/transfer/exports/[id]/files/[...path].js";
import { GET as exportGet } from "../../../src/astro/routes/api/admin/transfer/exports/[id]/index.js";
import { GET as exportManifestGet } from "../../../src/astro/routes/api/admin/transfer/exports/[id]/manifest.js";
import {
	GET as exportsGet,
	POST as exportsPost,
} from "../../../src/astro/routes/api/admin/transfer/exports/index.js";
import { POST as abandonPost } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/abandon.js";
import { POST as importAdvancePost } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/advance.js";
import { POST as analyzePost } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/analyze.js";
import { POST as cancelPost } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/cancel.js";
import { POST as executePost } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/execute.js";
import { PUT as filePut } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/files/[...path].js";
import { GET as importGet } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/index.js";
import { GET as missingGet } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/missing.js";
import { GET as planGet } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/plan.js";
import { GET as receiptGet } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/receipt.js";
import {
	GET as importsGet,
	POST as importsPost,
} from "../../../src/astro/routes/api/admin/transfer/imports/index.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { applySeed } from "../../../src/seed/apply.js";
import { defaultSeed } from "../../../src/seed/default.js";
import { finalizePlan } from "../../../src/transfer/analyze/step.js";
import { canonicalJson } from "../../../src/transfer/format/canonical.js";
import { sha256Hex, type Sha256Digest } from "../../../src/transfer/format/digest.js";
import { MANIFEST_PATH } from "../../../src/transfer/format/paths.js";
import { TransferApprovalRepository } from "../../../src/transfer/ops/approvals.js";
import { TransferOperationRepository } from "../../../src/transfer/ops/operations.js";
import { TransferStagedFileRepository } from "../../../src/transfer/ops/staged-files.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";
import { buildGoldenPackage } from "../../utils/transfer/golden-package.js";
import { createMemoryStorage, type MemoryStorage } from "../../utils/transfer/memory-storage.js";

type Handler = (context: never) => Promise<Response> | Response;

interface Caller {
	id: string;
	role: number;
}

const ADMIN: Caller = { id: "admin-1", role: Role.ADMIN };
const EDITOR: Caller = { id: "editor-1", role: Role.EDITOR };
const ALL_TRANSFER_SCOPES = ["transfer:export", "transfer:analyze", "transfer:execute"];
const GOLDEN_PREFIX = "transfers/fixtures/golden/";

interface CallOptions {
	method?: string;
	params?: Record<string, string>;
	body?: Uint8Array | string | ReadableStream<Uint8Array>;
	headers?: Record<string, string>;
	user?: Caller | null;
	tokenScopes?: string[];
	query?: string;
	config?: Record<string, unknown>;
}

interface ApiBody<T = Record<string, unknown>> {
	success: boolean;
	data: T;
	error: { code: string; message: string; details?: Record<string, unknown> };
}

async function json<T = Record<string, unknown>>(response: Response): Promise<ApiBody<T>> {
	return (await response.json()) as ApiBody<T>;
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
	expect(response.status).toBe(status);
	expect((await json(response)).error.code).toBe(code);
}

interface PublicOperation {
	id: string;
	state: string;
	planDigest: string | null;
}

describeEachDialect("site transfer API routes", (dialect) => {
	let ctx: DialectTestContext;
	let storage: MemoryStorage;
	let packageFiles: Map<string, Uint8Array>;
	let manifestBytes: Uint8Array;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		await applySeed(ctx.db, defaultSeed, { includeContent: false, onConflict: "skip" });
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		storage = createMemoryStorage();

		const source = createMemoryStorage();
		await buildGoldenPackage(source, { prefix: GOLDEN_PREFIX });
		packageFiles = new Map(
			Array.from(source.files, ([key, file]) => [key.slice(GOLDEN_PREFIX.length), file.body]),
		);
		manifestBytes = packageFiles.get(MANIFEST_PATH)!;
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(ctx);
	});

	function call(handler: Handler, path: string, options: CallOptions = {}): Promise<Response> {
		const url = new URL(
			`http://localhost/_emdash/api/admin/transfer/${path}${options.query ?? ""}`,
		);
		const request = new Request(url, {
			method: options.method ?? "GET",
			headers: options.headers,
			body: options.body,
			...(options.body instanceof ReadableStream ? { duplex: "half" } : {}),
		} as RequestInit);
		return Promise.resolve(
			handler({
				request,
				url,
				params: options.params ?? {},
				locals: {
					emdash: { db: ctx.db, storage, config: options.config ?? {} },
					user: options.user === undefined ? ADMIN : (options.user ?? undefined),
					tokenScopes: options.tokenScopes,
				},
			} as never),
		);
	}

	function createImport(
		options: { body?: Uint8Array; key?: string; user?: Caller; tokenScopes?: string[] } = {},
	): Promise<Response> {
		const body = options.body ?? manifestBytes;
		return call(importsPost, "imports", {
			method: "POST",
			body,
			headers: {
				"Content-Length": String(body.byteLength),
				...(options.key ? { "Idempotency-Key": options.key } : {}),
			},
			user: options.user,
			tokenScopes: options.tokenScopes,
		});
	}

	async function createdImport(): Promise<string> {
		const response = await createImport();
		expect(response.status).toBe(201);
		return (await json<{ operation: PublicOperation }>(response)).data.operation.id;
	}

	function upload(
		id: string,
		path: string,
		body: Uint8Array,
		options: { contentLength?: number | null; config?: Record<string, unknown> } = {},
	): Promise<Response> {
		const contentLength =
			options.contentLength === undefined ? body.byteLength : options.contentLength;
		return call(filePut, `imports/${id}/files/${path}`, {
			method: "PUT",
			params: { id, path },
			body,
			headers: contentLength === null ? {} : { "Content-Length": String(contentLength) },
			config: options.config,
		});
	}

	async function missing(id: string): Promise<Array<{ path: string; bytes: number }>> {
		const items: Array<{ path: string; bytes: number }> = [];
		let cursor: string | undefined;
		do {
			const response = await call(missingGet, `imports/${id}/missing`, {
				params: { id },
				query: `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
			});
			expect(response.status).toBe(200);
			const page = (
				await json<{ items: Array<{ path: string; bytes: number }>; nextCursor?: string }>(response)
			).data;
			items.push(...page.items);
			cursor = page.nextCursor;
		} while (cursor);
		return items;
	}

	async function uploadAll(id: string): Promise<number> {
		let uploads = 0;
		for (let round = 0; round < 10; round++) {
			const pending = await missing(id);
			if (pending.length === 0) return uploads;
			for (const file of pending) {
				const response = await upload(id, file.path, packageFiles.get(file.path)!);
				expect(response.status).toBe(200);
				uploads++;
			}
		}
		throw new Error("uploads did not converge");
	}

	async function analyzeToPlan(
		id: string,
	): Promise<{ operation: PublicOperation; plan: { blockers: unknown[] }; planDigest: string }> {
		for (let step = 0; step < 1000; step++) {
			const response = await call(analyzePost, `imports/${id}/analyze`, {
				method: "POST",
				params: { id },
			});
			expect(response.status).toBe(200);
			const data = (
				await json<{
					operation: PublicOperation;
					plan?: { blockers: unknown[] };
					planDigest?: string;
					nextRequestInMs: number | null;
				}>(response)
			).data;
			if (data.nextRequestInMs === null) {
				if (!data.plan || !data.planDigest) throw new Error("analysis ended without a plan");
				return { operation: data.operation, plan: data.plan, planDigest: data.planDigest };
			}
		}
		throw new Error("analysis did not finish");
	}

	describe("authorization", () => {
		const routes: Array<{
			name: string;
			handler: Handler;
			method: string;
			scope: string | null;
		}> = [
			{ name: "GET capabilities", handler: capabilitiesGet, method: "GET", scope: "any" },
			{ name: "GET imports", handler: importsGet, method: "GET", scope: "read" },
			{ name: "POST imports", handler: importsPost, method: "POST", scope: "transfer:analyze" },
			{ name: "GET import", handler: importGet, method: "GET", scope: "read" },
			{ name: "GET missing", handler: missingGet, method: "GET", scope: "transfer:analyze" },
			{ name: "PUT file", handler: filePut, method: "PUT", scope: "transfer:analyze" },
			{ name: "POST analyze", handler: analyzePost, method: "POST", scope: "transfer:analyze" },
			{ name: "GET plan", handler: planGet, method: "GET", scope: "read" },
			{ name: "POST cancel", handler: cancelPost, method: "POST", scope: "transfer:execute" },
			{ name: "POST abandon", handler: abandonPost, method: "POST", scope: "transfer:execute" },
			{ name: "POST execute", handler: executePost, method: "POST", scope: "transfer:execute" },
			{
				name: "POST import advance",
				handler: importAdvancePost,
				method: "POST",
				scope: "transfer:execute",
			},
			{ name: "GET receipt", handler: receiptGet, method: "GET", scope: "read" },
			{ name: "GET exports", handler: exportsGet, method: "GET", scope: "transfer:export" },
			{ name: "POST exports", handler: exportsPost, method: "POST", scope: "transfer:export" },
			{ name: "GET export", handler: exportGet, method: "GET", scope: "transfer:export" },
			{
				name: "POST export advance",
				handler: exportAdvancePost,
				method: "POST",
				scope: "transfer:export",
			},
			{
				name: "GET export manifest",
				handler: exportManifestGet,
				method: "GET",
				scope: "transfer:export",
			},
			{ name: "GET export file", handler: exportFileGet, method: "GET", scope: "transfer:export" },
			{
				name: "GET export archive",
				handler: exportArchiveGet,
				method: "GET",
				scope: "transfer:export",
			},
			{ name: "GET approvals", handler: approvalsGet, method: "GET", scope: null },
			{ name: "POST approve", handler: approvePost, method: "POST", scope: null },
			{ name: "POST deny", handler: denyPost, method: "POST", scope: null },
		];

		function allowed(scope: string | null, tokenScopes: string[]): boolean {
			if (scope === null) return false;
			if (tokenScopes.includes("admin")) return true;
			if (scope === "any") return tokenScopes.some((s) => ALL_TRANSFER_SCOPES.includes(s));
			if (scope === "read") {
				return tokenScopes.includes("transfer:analyze") || tokenScopes.includes("transfer:execute");
			}
			return tokenScopes.includes(scope);
		}

		for (const route of routes) {
			it(`${route.name} requires an authenticated admin`, async () => {
				const options = { method: route.method, params: { id: "01ABC", path: MANIFEST_PATH } };
				await expectError(
					await call(route.handler, "x", { ...options, user: null }),
					401,
					"UNAUTHORIZED",
				);
				await expectError(
					await call(route.handler, "x", { ...options, user: EDITOR }),
					403,
					"FORBIDDEN",
				);
			});

			it(`${route.name} enforces its own token scope`, async () => {
				const options = { method: route.method, params: { id: "01ABC", path: MANIFEST_PATH } };
				for (const tokenScopes of [
					["admin"],
					["transfer:export"],
					["transfer:analyze"],
					["transfer:execute"],
					["admin", ...ALL_TRANSFER_SCOPES],
				]) {
					const response = await call(route.handler, "x", { ...options, tokenScopes });
					if (allowed(route.scope, tokenScopes)) {
						expect([401, 403]).not.toContain(response.status);
					} else {
						expect(response.status).toBe(403);
						const code = (await json(response)).error.code;
						expect(code).toBe(route.scope === null ? "FORBIDDEN" : "INSUFFICIENT_SCOPE");
					}
				}
			});
		}
	});

	describe("capabilities", () => {
		it("reports formats, limits, and whether the site can receive an import", async () => {
			const response = await call(capabilitiesGet, "capabilities", {
				config: { maxUploadSize: 1234 },
			});
			expect(response.status).toBe(200);
			const data = (
				await json<{
					formatVersions: string[];
					limits: { maxBlobBytes: number; manifestBytes: number };
					portableDomain: { empty: boolean; blockers: unknown[] };
				}>(response)
			).data;
			expect(data.formatVersions).toEqual(["1"]);
			expect(data.limits.maxBlobBytes).toBe(1234);
			expect(data.limits.manifestBytes).toBe(8 * 1024 * 1024);
			expect(data.portableDomain).toMatchObject({ empty: true, blockers: [] });

			await ctx.db
				.insertInto("media_folders")
				.values({ id: "f1", name: "F", name_key: "f" })
				.execute();
			const after = (
				await json<{ portableDomain: { empty: boolean; blockers: unknown[] } }>(
					await call(capabilitiesGet, "capabilities"),
				)
			).data;
			expect(after.portableDomain.empty).toBe(false);
			expect(after.portableDomain.blockers).toContainEqual({
				code: "table_not_empty",
				table: "media_folders",
			});
		});
	});

	describe("import upload and analysis", () => {
		it("stages a package, lists missing files, analyzes it, and applies decisions", async () => {
			const created = await createImport({ key: "run-1" });
			expect(created.status).toBe(201);
			const body = await json<{
				operation: PublicOperation & Record<string, unknown>;
				created: boolean;
				missing: { items: Array<{ path: string }> };
			}>(created);
			expect(body.data.created).toBe(true);
			expect(body.data.operation.state).toBe("uploading");
			expect(body.data.operation).not.toHaveProperty("stagingSecret");
			expect(body.data.operation).not.toHaveProperty("leaseToken");
			expect(body.data.missing.items.map((item) => item.path)).toEqual(
				[...packageFiles.keys()].filter((path) => path.startsWith("index/")).toSorted(),
			);
			const id = body.data.operation.id;

			const uploads = await uploadAll(id);
			expect(uploads).toBe(packageFiles.size - 1);

			const status = await json<{ files: { declared: number; verified: number } }>(
				await call(importGet, `imports/${id}`, { params: { id } }),
			);
			expect(status.data.files).toEqual({ declared: 0, verified: packageFiles.size });

			const planned = await analyzeToPlan(id);
			expect(planned.operation.state).toBe("planned");
			expect(planned.plan.blockers).toEqual([]);
			expect(planned.planDigest).toBe(planned.operation.planDigest);

			const plan = await json<{ planDigest: string }>(
				await call(planGet, `imports/${id}/plan`, { params: { id } }),
			);
			expect(plan.data.planDigest).toBe(planned.planDigest);

			const decided = await call(analyzePost, `imports/${id}/analyze`, {
				method: "POST",
				params: { id },
				body: JSON.stringify({ decisions: { siteTitle: "target" } }),
				headers: { "Content-Type": "application/json" },
			});
			expect(decided.status).toBe(200);
			const decidedData = (
				await json<{
					plan: { decisions: { siteTitle: string } };
					planDigest: string;
					operation: PublicOperation;
				}>(decided)
			).data;
			expect(decidedData.plan.decisions.siteTitle).toBe("target");
			expect(decidedData.planDigest).not.toBe(planned.planDigest);
			expect(decidedData.operation.planDigest).toBe(decidedData.planDigest);

			const list = await json<{ items: PublicOperation[] }>(await call(importsGet, "imports"));
			expect(list.data.items.map((item) => item.id)).toEqual([id]);
			expect(JSON.stringify(list.data)).not.toContain("stagingSecret");
		});

		it("rejects malformed decisions before running analysis", async () => {
			const id = await createdImport();
			await uploadAll(id);
			const response = await call(analyzePost, `imports/${id}/analyze`, {
				method: "POST",
				params: { id },
				body: JSON.stringify({ decisions: { siteTitle: "neither" } }),
				headers: { "Content-Type": "application/json" },
			});
			await expectError(response, 400, "VALIDATION_ERROR");
		});

		it("refuses to analyze until every declared file is uploaded", async () => {
			const id = await createdImport();
			await expectError(
				await call(analyzePost, `imports/${id}/analyze`, { method: "POST", params: { id } }),
				422,
				"TRANSFER_FILE_MISSING",
			);
		});

		it("refuses uploads once analysis has started", async () => {
			const id = await createdImport();
			await uploadAll(id);
			await analyzeToPlan(id);
			await expectError(
				await upload(id, MANIFEST_PATH, manifestBytes),
				409,
				"TRANSFER_INVALID_STATE",
			);
		});

		it("freezes the plan once execution is requested", async () => {
			const id = await createdImport();
			await uploadAll(id);
			const planned = await analyzeToPlan(id);
			const packageDigest = (await new TransferOperationRepository(ctx.db).require(id))
				.packageDigest;
			const executed = await call(executePost, `imports/${id}/execute`, {
				method: "POST",
				params: { id },
				body: JSON.stringify({ packageDigest, planDigest: planned.planDigest }),
				headers: { "Content-Type": "application/json" },
			});
			expect(executed.status).toBe(200);

			await expectError(
				await call(analyzePost, `imports/${id}/analyze`, {
					method: "POST",
					params: { id },
					body: JSON.stringify({ decisions: { siteTitle: "target" } }),
					headers: { "Content-Type": "application/json" },
				}),
				409,
				"TRANSFER_INVALID_STATE",
			);
			await expect(
				finalizePlan({ db: ctx.db, storage, operationId: id, decisions: { siteTitle: "target" } }),
			).rejects.toMatchObject({ code: "TRANSFER_INVALID_STATE" });

			const plan = await json<{ planDigest: string; plan: { decisions: { siteTitle: string } } }>(
				await call(planGet, `imports/${id}/plan`, { params: { id } }),
			);
			expect(plan.data.planDigest).toBe(planned.planDigest);
			expect(plan.data.plan.decisions.siteTitle).toBe("package");
			expect((await new TransferOperationRepository(ctx.db).require(id)).planDigest).toBe(
				planned.planDigest,
			);

			const reread = await call(analyzePost, `imports/${id}/analyze`, {
				method: "POST",
				params: { id },
			});
			expect(reread.status).toBe(200);
			expect((await json<{ planDigest: string }>(reread)).data.planDigest).toBe(planned.planDigest);
		});

		it("returns 404 for unknown operations and for exports", async () => {
			await expectError(
				await call(importGet, "imports/nope", { params: { id: "01HZ0000000000000000000000" } }),
				404,
				"TRANSFER_OPERATION_NOT_FOUND",
			);
			const { operation } = await new TransferOperationRepository(ctx.db).create({
				kind: "export",
				createdBy: ADMIN.id,
			});
			for (const handler of [importGet, planGet, missingGet]) {
				await expectError(
					await call(handler, "x", { params: { id: operation.id } }),
					404,
					"TRANSFER_OPERATION_NOT_FOUND",
				);
			}
			await expectError(
				await call(cancelPost, "x", { method: "POST", params: { id: operation.id } }),
				404,
				"TRANSFER_OPERATION_NOT_FOUND",
			);
		});
	});

	describe("import creation", () => {
		it("returns the same operation for a repeated idempotency key and manifest", async () => {
			const first = await json<{ operation: PublicOperation }>(await createImport({ key: "k" }));
			const again = await createImport({ key: "k" });
			expect(again.status).toBe(200);
			const body = await json<{ operation: PublicOperation; created: boolean }>(again);
			expect(body.data.created).toBe(false);
			expect(body.data.operation.id).toBe(first.data.operation.id);
		});

		it("rejects a reused idempotency key with a different manifest", async () => {
			await createImport({ key: "k" });
			const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as Record<
				string,
				unknown
			>;
			const other = new TextEncoder().encode(
				canonicalJson({ ...manifest, createdAt: "2026-04-02T00:00:00.000Z" }),
			);
			await expectError(
				await createImport({ key: "k", body: other }),
				409,
				"TRANSFER_IDEMPOTENCY_CONFLICT",
			);
		});

		it("allows one import at a time", async () => {
			await createImport();
			await expectError(await createImport(), 503, "TRANSFER_IMPORT_IN_PROGRESS");
		});

		it("rejects invalid idempotency keys", async () => {
			await expectError(await createImport({ key: "has space" }), 400, "VALIDATION_ERROR");
		});

		it("rejects invalid and oversized manifests", async () => {
			await expectError(
				await createImport({ body: new TextEncoder().encode('{"format":"nope"}') }),
				422,
				"TRANSFER_UNSUPPORTED_FORMAT",
			);
			await expectError(
				await createImport({ body: new TextEncoder().encode("{ not json") }),
				422,
				"TRANSFER_MANIFEST_INVALID",
			);

			const declaredTooLarge = await call(importsPost, "imports", {
				method: "POST",
				body: manifestBytes,
				headers: { "Content-Length": String(8 * 1024 * 1024 + 1) },
			});
			await expectError(declaredTooLarge, 413, "TRANSFER_LIMIT_EXCEEDED");

			const chunk = new Uint8Array(1024 * 1024);
			let sent = 0;
			const stream = new ReadableStream<Uint8Array>({
				pull(controller) {
					if (sent >= 9) controller.close();
					else {
						sent++;
						controller.enqueue(chunk);
					}
				},
			});
			const streamedTooLarge = await call(importsPost, "imports", { method: "POST", body: stream });
			await expectError(streamedTooLarge, 413, "TRANSFER_LIMIT_EXCEEDED");
			expect(sent).toBeLessThan(10);
		});

		it("refuses to import into a site that already has content", async () => {
			await ctx.db
				.insertInto("media_folders")
				.values({ id: "f1", name: "F", name_key: "f" })
				.execute();
			await expectError(await createImport(), 409, "TRANSFER_TARGET_NOT_EMPTY");
		});
	});

	describe("file uploads", () => {
		let id: string;
		let indexPath: string;

		beforeEach(async () => {
			id = await createdImport();
			indexPath = [...packageFiles.keys()].find((path) => path.startsWith("index/"))!;
		});

		function stagedKeys(): string[] {
			return [...storage.files.keys()].filter((key) => key.includes(`/${id}-`));
		}

		it("requires Content-Length equal to the declared size", async () => {
			const bytes = packageFiles.get(indexPath)!;
			await expectError(
				await upload(id, indexPath, bytes, { contentLength: null }),
				411,
				"LENGTH_REQUIRED",
			);
			await expectError(
				await upload(id, indexPath, bytes, { contentLength: bytes.byteLength - 1 }),
				422,
				"TRANSFER_FILE_SIZE_MISMATCH",
			);
			expect(await new TransferStagedFileRepository(ctx.db).isVerified(id, indexPath)).toBe(false);
		});

		it("rejects bytes that do not match the declared digest and keeps nothing", async () => {
			const bytes = packageFiles.get(indexPath)!;
			const tampered = new Uint8Array(bytes);
			tampered[0] = tampered[0]! ^ 1;
			const before = stagedKeys();
			await expectError(
				await upload(id, indexPath, tampered),
				422,
				"TRANSFER_FILE_DIGEST_MISMATCH",
			);
			expect(stagedKeys()).toEqual(before);
			expect(await new TransferStagedFileRepository(ctx.db).isVerified(id, indexPath)).toBe(false);
		});

		it("rejects valid paths the package does not declare", async () => {
			const blob = new TextEncoder().encode("hello");
			const path = `media/${await sha256Hex(blob)}`;
			await expectError(await upload(id, path, blob), 422, "TRANSFER_FILE_NOT_DECLARED");
			const recordPath = [...packageFiles.keys()].find((p) => p.startsWith("records/"))!;
			await expectError(
				await upload(id, recordPath, packageFiles.get(recordPath)!),
				422,
				"TRANSFER_FILE_NOT_DECLARED",
			);
		});

		it.each([
			"../manifest.json",
			"records/../manifest.json",
			"./manifest.json",
			"/manifest.json",
			"records\\entry\\000000.ndjson",
			"Manifest.json",
			"index/0.ndjson",
			"media/ABCDEF",
			"records/entry/000000.ndjson/..",
			"records%2Fentry%2F000000.ndjson",
			"_plan.json",
			"_analysis/context.json",
		])("rejects the invalid package path %s", async (path) => {
			await expectError(await upload(id, path, new Uint8Array(1)), 422, "TRANSFER_PATH_INVALID");
		});

		it("rejects media larger than the site accepts before reading the body", async () => {
			await uploadAll(id).catch(() => undefined);
			const blobPath = [...packageFiles.keys()].find((path) => path.startsWith("media/"))!;
			const operations = new TransferOperationRepository(ctx.db);
			const fresh = await operations.get(id);
			expect(fresh?.state).toBe("uploading");
			await ctx.db
				.updateTable("_emdash_transfer_staged_files")
				.set({ state: "declared" })
				.where("operation_id", "=", id)
				.where("path", "=", blobPath)
				.execute();
			await expectError(
				await upload(id, blobPath, packageFiles.get(blobPath)!, { config: { maxUploadSize: 1 } }),
				413,
				"TRANSFER_LIMIT_EXCEEDED",
			);
		});

		it("accepts a verified file again only with identical bytes", async () => {
			const bytes = packageFiles.get(indexPath)!;
			const first = await upload(id, indexPath, bytes);
			expect((await json<{ alreadyVerified: boolean }>(first)).data.alreadyVerified).toBe(false);

			const again = await upload(id, indexPath, bytes);
			expect(again.status).toBe(200);
			expect((await json<{ alreadyVerified: boolean }>(again)).data.alreadyVerified).toBe(true);

			const stored = [...storage.files.entries()].find(([key]) => key.endsWith(indexPath))!;
			const tampered = new Uint8Array(bytes);
			tampered[0] = tampered[0]! ^ 1;
			await expectError(
				await upload(id, indexPath, tampered),
				422,
				"TRANSFER_FILE_DIGEST_MISMATCH",
			);
			expect(storage.files.get(stored[0])?.body).toEqual(bytes);
			expect(await new TransferStagedFileRepository(ctx.db).isVerified(id, indexPath)).toBe(true);
		});

		it("lets an upload repair a verified file a failed concurrent upload overwrote", async () => {
			const bytes = packageFiles.get(indexPath)!;
			const tampered = new Uint8Array(bytes);
			tampered[0] = tampered[0]! ^ 1;
			let reading!: () => void;
			const started = new Promise<void>((resolve) => (reading = resolve));
			let release!: () => void;
			const released = new Promise<void>((resolve) => (release = resolve));
			const failing = call(filePut, `imports/${id}/files/${indexPath}`, {
				method: "PUT",
				params: { id, path: indexPath },
				headers: { "Content-Length": String(bytes.byteLength) },
				body: new ReadableStream<Uint8Array>({
					async pull(controller) {
						reading();
						await released;
						controller.enqueue(tampered);
						controller.close();
					},
				}),
			});
			await started;
			expect((await upload(id, indexPath, bytes)).status).toBe(200);
			release();
			await expectError(await failing, 422, "TRANSFER_FILE_DIGEST_MISMATCH");
			const key = [...storage.files.keys()].find((stored) => stored.endsWith(indexPath))!;
			expect(storage.files.get(key)?.body).toEqual(tampered);

			await expectError(
				await upload(id, indexPath, tampered),
				422,
				"TRANSFER_FILE_DIGEST_MISMATCH",
			);
			const repaired = await upload(id, indexPath, bytes);
			expect(repaired.status).toBe(200);
			expect((await json<{ alreadyVerified: boolean }>(repaired)).data.alreadyVerified).toBe(false);
			expect(storage.files.get(key)?.body).toEqual(bytes);

			const again = await upload(id, indexPath, bytes);
			expect((await json<{ alreadyVerified: boolean }>(again)).data.alreadyVerified).toBe(true);
			expect(await new TransferStagedFileRepository(ctx.db).isVerified(id, indexPath)).toBe(true);
		});

		it("declares the files an index chunk lists once it is uploaded", async () => {
			const before = await missing(id);
			expect(before.every((file) => file.path.startsWith("index/"))).toBe(true);
			await upload(id, indexPath, packageFiles.get(indexPath)!);
			const after = await missing(id);
			expect(after.some((file) => file.path.startsWith("records/"))).toBe(true);
		});
	});

	describe("cancel and abandon", () => {
		it("cancels a pending import and then abandons it", async () => {
			const id = await createdImport();
			await expectError(
				await call(abandonPost, "x", { method: "POST", params: { id } }),
				409,
				"TRANSFER_INVALID_STATE",
			);
			const cancelled = await call(cancelPost, "x", { method: "POST", params: { id } });
			expect(cancelled.status).toBe(200);
			expect((await json<{ operation: PublicOperation }>(cancelled)).data.operation.state).toBe(
				"cancelled",
			);
			const abandoned = await call(abandonPost, "x", { method: "POST", params: { id } });
			expect((await json<{ operation: PublicOperation }>(abandoned)).data.operation.state).toBe(
				"abandoned",
			);
			await expectError(
				await call(cancelPost, "x", { method: "POST", params: { id } }),
				409,
				"TRANSFER_INVALID_STATE",
			);
			expect((await createImport()).status).toBe(201);
		});
	});

	describe("approvals", () => {
		async function pendingApproval(action: "export" | "import" = "export"): Promise<string> {
			const result = await requestTransferApproval(ctx.db, {
				userId: ADMIN.id,
				action,
				requestedByTokenId: "token-1",
				...(action === "import"
					? { packageDigest: `sha256:${"a".repeat(64)}`, planDigest: `sha256:${"b".repeat(64)}` }
					: {}),
			});
			expect(result.error.code).toBe("TRANSFER_APPROVAL_REQUIRED");
			return String(result.error.details?.approvalId);
		}

		it("lists pending approvals and lets a session approve one once", async () => {
			const approvalId = await pendingApproval();
			const listed = await json<{ items: Array<{ id: string; status: string }> }>(
				await call(approvalsGet, "approvals", { query: "?status=pending" }),
			);
			expect(listed.data.items).toEqual([
				expect.objectContaining({ id: approvalId, status: "pending" }),
			]);

			const approved = await call(approvePost, "x", { method: "POST", params: { id: approvalId } });
			expect(approved.status).toBe(200);
			expect(
				(await json<{ approval: { status: string; approvedBy: string } }>(approved)).data.approval,
			).toMatchObject({ status: "approved", approvedBy: ADMIN.id });

			await expectError(
				await call(approvePost, "x", { method: "POST", params: { id: approvalId } }),
				403,
				"TRANSFER_APPROVAL_INVALID",
			);
			await expectError(
				await call(denyPost, "x", { method: "POST", params: { id: approvalId } }),
				403,
				"TRANSFER_APPROVAL_INVALID",
			);
		});

		it("denies a pending approval", async () => {
			const approvalId = await pendingApproval("import");
			const denied = await call(denyPost, "x", { method: "POST", params: { id: approvalId } });
			expect((await json<{ approval: { status: string } }>(denied)).data.approval.status).toBe(
				"denied",
			);
		});

		it("never lets a bearer token decide an approval, whatever its scopes", async () => {
			const approvalId = await pendingApproval();
			for (const handler of [approvePost, denyPost]) {
				await expectError(
					await call(handler, "x", {
						method: "POST",
						params: { id: approvalId },
						tokenScopes: ["admin", ...ALL_TRANSFER_SCOPES],
					}),
					403,
					"FORBIDDEN",
				);
			}
			const stored = await json<{ items: Array<{ status: string }> }>(
				await call(approvalsGet, "approvals"),
			);
			expect(stored.data.items[0]?.status).toBe("pending");
		});

		it("keeps an import grant usable when execution could not start", async () => {
			const id = await createdImport();
			await uploadAll(id);
			const { planDigest } = await analyzeToPlan(id);
			const operations = new TransferOperationRepository(ctx.db);
			const packageDigest = (await operations.require(id)).packageDigest!;
			const binding = {
				operationId: id,
				packageDigest,
				planDigest: planDigest as Sha256Digest,
			};
			const pending = await requestTransferApproval(ctx.db, {
				userId: ADMIN.id,
				action: "import",
				requestedByTokenId: "token-1",
				...binding,
			});
			const approvalId = String(pending.error.details?.approvalId);
			await call(approvePost, "x", { method: "POST", params: { id: approvalId } });
			const execute = () =>
				handleImportExecute(ctx.db, storage, {
					userId: ADMIN.id,
					...binding,
					approval: { id: approvalId, tokenId: "token-1" },
				});

			const busy = await operations.claim(id, ["planned"]);
			const refused = await execute();
			expect(refused.success ? null : refused.error.code).toBe("TRANSFER_LEASE_ACTIVE");
			expect((await new TransferApprovalRepository(ctx.db).get(approvalId))?.status).toBe(
				"approved",
			);
			if (busy.outcome === "claimed") await operations.release(id, busy.leaseToken);

			const started = await execute();
			expect(started.success).toBe(true);
			expect((await new TransferApprovalRepository(ctx.db).get(approvalId))?.status).toBe(
				"consumed",
			);
			const replay = await execute();
			expect(replay.success ? null : replay.error.code).toBe("TRANSFER_APPROVAL_INVALID");
		});

		it("keeps an export grant usable when the export could not be created", async () => {
			const pending = await requestTransferApproval(ctx.db, {
				userId: ADMIN.id,
				action: "export",
				paramsDigest: await exportParamsDigest({}),
				requestedByTokenId: "token-1",
			});
			const approvalId = String(pending.error.details?.approvalId);
			await call(approvePost, "x", { method: "POST", params: { id: approvalId } });
			let failInsert = true;
			const flaky = ctx.db.withPlugin({
				transformQuery(args) {
					if (
						failInsert &&
						args.node.kind === "InsertQueryNode" &&
						JSON.stringify(args.node.into).includes("_emdash_transfer_operations")
					) {
						failInsert = false;
						throw new Error("database unavailable");
					}
					return args.node;
				},
				async transformResult(args) {
					return args.result;
				},
			});
			const create = (db: typeof ctx.db) =>
				handleExportCreate(db, {
					userId: ADMIN.id,
					options: {},
					approval: { id: approvalId, tokenId: "token-1" },
				});

			const failed = await create(flaky);
			expect(failed.success).toBe(false);
			expect((await new TransferApprovalRepository(ctx.db).get(approvalId))?.status).toBe(
				"approved",
			);
			const created = await create(ctx.db);
			expect(created.success).toBe(true);
			const approval = await new TransferApprovalRepository(ctx.db).get(approvalId);
			expect(approval).toMatchObject({
				status: "consumed",
				operationId: created.success ? created.data.operation.id : null,
			});
		});

		it("rejects unknown approvals", async () => {
			await expectError(
				await call(approvePost, "x", { method: "POST", params: { id: "missing" } }),
				403,
				"TRANSFER_APPROVAL_INVALID",
			);
		});
	});

	it("never exposes the staging secret", async () => {
		const id = await createdImport();
		const operation = await new TransferOperationRepository(ctx.db).require(id);
		const responses = [
			await call(importGet, "x", { params: { id } }),
			await call(importsGet, "imports"),
			await call(cancelPost, "x", { method: "POST", params: { id } }),
		];
		for (const response of responses) {
			expect(await response.text()).not.toContain(operation.stagingSecret);
		}
	});
});
