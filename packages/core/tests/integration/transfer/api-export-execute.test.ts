/**
 * The export, download, execute, advance, and receipt routes over HTTP-shaped
 * route calls: an origin site is exported through the routes, downloaded as
 * an archive, uploaded into a second site through the import routes,
 * analyzed, executed, and advanced to a receipt.
 */

import { Role } from "@emdash-cms/auth";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import {
	exportParamsDigest,
	handleExportCreate,
	handleImportExecute,
	requestTransferApproval,
} from "../../../src/api/handlers/transfer.js";
import { POST as approvePost } from "../../../src/astro/routes/api/admin/transfer/approvals/[id]/approve.js";
import { POST as exportAdvancePost } from "../../../src/astro/routes/api/admin/transfer/exports/[id]/advance.js";
import { GET as exportArchiveGet } from "../../../src/astro/routes/api/admin/transfer/exports/[id]/archive.js";
import { GET as exportFileGet } from "../../../src/astro/routes/api/admin/transfer/exports/[id]/files/[...path].js";
import { GET as exportGet } from "../../../src/astro/routes/api/admin/transfer/exports/[id]/index.js";
import { GET as exportManifestGet } from "../../../src/astro/routes/api/admin/transfer/exports/[id]/manifest.js";
import {
	GET as exportsGet,
	POST as exportsPost,
} from "../../../src/astro/routes/api/admin/transfer/exports/index.js";
import { POST as importAdvancePost } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/advance.js";
import { POST as analyzePost } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/analyze.js";
import { POST as executePost } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/execute.js";
import { PUT as filePut } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/files/[...path].js";
import { GET as missingGet } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/missing.js";
import { GET as receiptGet } from "../../../src/astro/routes/api/admin/transfer/imports/[id]/receipt.js";
import { POST as importsPost } from "../../../src/astro/routes/api/admin/transfer/imports/index.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { applySeed } from "../../../src/seed/apply.js";
import { defaultSeed } from "../../../src/seed/default.js";
import { unpackSitePackage } from "../../../src/transfer/container/tar.js";
import { sha256Hex, type Sha256Digest } from "../../../src/transfer/format/digest.js";
import { parseIndexLine } from "../../../src/transfer/format/manifest.js";
import { MANIFEST_PATH } from "../../../src/transfer/format/paths.js";
import {
	verifyReceiptDigest,
	type SiteImportReceipt,
} from "../../../src/transfer/format/receipt.js";
import { TransferApprovalRepository } from "../../../src/transfer/ops/approvals.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";
import { createMemoryStorage, type MemoryStorage } from "../../utils/transfer/memory-storage.js";
import { buildOriginSite, type OriginSite } from "../../utils/transfer/origin-site.js";

type Handler = (context: never) => Promise<Response> | Response;

interface Site {
	db: Kysely<Database>;
	storage: MemoryStorage;
}

interface CallOptions {
	method?: string;
	params?: Record<string, string>;
	body?: Uint8Array | string;
	headers?: Record<string, string>;
	user?: { id: string; role: number };
	tokenScopes?: string[];
	query?: string;
}

interface PublicOperation {
	id: string;
	state: string;
	packageDigest: string | null;
	planDigest: string | null;
	errorCode: string | null;
	errorDetail: unknown;
	receipt: SiteImportReceipt | null;
}

interface ApiBody<T> {
	data: T;
	error: { code: string; details?: Record<string, unknown> };
}

const ORIGIN_ADMIN = { id: "origin-admin", role: Role.ADMIN };
const TARGET_BOB = { id: "target_bob", role: Role.ADMIN };
const SHA_A = `sha256:${"a".repeat(64)}` as Sha256Digest;
const MAX_STEPS = 2000;

async function json<T>(response: Response): Promise<ApiBody<T>> {
	return (await response.json()) as ApiBody<T>;
}

async function expectError(response: Response, status: number, code: string): Promise<void> {
	expect(response.status).toBe(status);
	expect((await json(response)).error.code).toBe(code);
}

function call(site: Site, handler: Handler, options: CallOptions = {}): Promise<Response> {
	const url = new URL(`http://localhost/_emdash/api/admin/transfer/x${options.query ?? ""}`);
	const request = new Request(url, {
		method: options.method ?? "GET",
		headers: options.headers,
		body: options.body,
	});
	return Promise.resolve(
		handler({
			request,
			url,
			params: options.params ?? {},
			locals: {
				emdash: { db: site.db, storage: site.storage, config: {} },
				user: options.user ?? ORIGIN_ADMIN,
				tokenScopes: options.tokenScopes,
			},
		} as never),
	);
}

function jsonBody(value: unknown): Pick<CallOptions, "body" | "headers"> {
	return { body: JSON.stringify(value), headers: { "Content-Type": "application/json" } };
}

describeEachDialect("site transfer export and execute routes", (dialect) => {
	let sourceCtx: DialectTestContext;
	let targetCtx: DialectTestContext | undefined;
	let origin: Site;
	let site: OriginSite;

	beforeEach(async () => {
		sourceCtx = await setupForDialect(dialect);
		origin = { db: sourceCtx.db, storage: createMemoryStorage() };
		site = await buildOriginSite(origin.db, origin.storage);
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
	});

	afterEach(async () => {
		setI18nConfig(null);
		await teardownForDialect(sourceCtx);
		await teardownForDialect(targetCtx);
		targetCtx = undefined;
	});

	async function createTarget(): Promise<Site> {
		targetCtx = await setupForDialect(dialect);
		await applySeed(targetCtx.db, defaultSeed, { includeContent: false, onConflict: "skip" });
		await targetCtx.db
			.insertInto("users")
			.values({
				id: TARGET_BOB.id,
				email: "Bob@Example.com",
				name: "Target Bob",
				avatar_url: null,
				role: Role.ADMIN,
				email_verified: 1,
				data: null,
			})
			.execute();
		return { db: targetCtx.db, storage: createMemoryStorage() };
	}

	async function startExport(): Promise<string> {
		const response = await call(origin, exportsPost, { method: "POST" });
		expect(response.status).toBe(201);
		return (await json<{ operation: PublicOperation }>(response)).data.operation.id;
	}

	async function completeExport(id: string): Promise<PublicOperation> {
		for (let step = 0; step < MAX_STEPS; step++) {
			const response = await call(origin, exportAdvancePost, { method: "POST", params: { id } });
			expect(response.status).toBe(200);
			const data = (
				await json<{ operation: PublicOperation; nextRequestInMs: number | null }>(response)
			).data;
			if (data.nextRequestInMs === null) {
				expect(data.operation.errorDetail).toBeNull();
				expect(data.operation.state).toBe("complete");
				return data.operation;
			}
		}
		throw new Error("export did not finish");
	}

	async function exportedPackage(): Promise<{ id: string; files: Map<string, Uint8Array> }> {
		const id = (await completeExport(await startExport())).id;
		const archive = await call(origin, exportArchiveGet, { params: { id } });
		expect(archive.status).toBe(200);
		expect(archive.headers.get("Content-Type")).toBe("application/x-tar");
		const files = new Map<string, Uint8Array>();
		const order: string[] = [];
		await unpackSitePackage(archive.body!, async (file) => {
			order.push(file.path);
			files.set(file.path, new Uint8Array(await new Response(file.body).arrayBuffer()));
		});
		expect(order[0]).toBe(MANIFEST_PATH);
		return { id, files };
	}

	it("creates exports idempotently and lists them", async () => {
		const headers = { "Idempotency-Key": "export-1", "Content-Type": "application/json" };
		const first = await call(origin, exportsPost, {
			method: "POST",
			body: JSON.stringify({ comments: false }),
			headers,
		});
		expect(first.status).toBe(201);
		const created = (await json<{ operation: PublicOperation & { options: unknown } }>(first)).data;
		expect(created.operation.options).toEqual({ comments: false });
		expect(created.operation).not.toHaveProperty("stagingSecret");

		const again = await call(origin, exportsPost, {
			method: "POST",
			body: JSON.stringify({ comments: false }),
			headers,
		});
		expect(again.status).toBe(200);
		expect((await json<{ operation: PublicOperation }>(again)).data.operation.id).toBe(
			created.operation.id,
		);
		await expectError(
			await call(origin, exportsPost, {
				method: "POST",
				body: JSON.stringify({ comments: true }),
				headers,
			}),
			409,
			"TRANSFER_IDEMPOTENCY_CONFLICT",
		);
		await expectError(
			await call(origin, exportsPost, { method: "POST", body: "{}", headers }),
			409,
			"TRANSFER_IDEMPOTENCY_CONFLICT",
		);

		await expectError(
			await call(origin, exportsPost, { method: "POST", ...jsonBody({ comments: "yes" }) }),
			400,
			"VALIDATION_ERROR",
		);
		await expectError(
			await call(origin, exportsPost, { method: "POST", ...jsonBody({ extra: true }) }),
			400,
			"VALIDATION_ERROR",
		);

		const listed = await json<{ items: PublicOperation[] }>(await call(origin, exportsGet));
		expect(listed.data.items.map((item) => item.id)).toEqual([created.operation.id]);
		const one = await json<{ operation: PublicOperation }>(
			await call(origin, exportGet, { params: { id: created.operation.id } }),
		);
		expect(one.data.operation.state).toBe("pending");
	});

	it("serves nothing before an export is complete", async () => {
		const id = await startExport();
		await expectError(
			await call(origin, exportManifestGet, { params: { id } }),
			409,
			"TRANSFER_INVALID_STATE",
		);
		await expectError(
			await call(origin, exportArchiveGet, { params: { id } }),
			409,
			"TRANSFER_INVALID_STATE",
		);
	});

	it("serves every declared file with its size and digest, and refuses anything else", async () => {
		const id = (await completeExport(await startExport())).id;
		const manifestResponse = await call(origin, exportManifestGet, { params: { id } });
		expect(manifestResponse.status).toBe(200);
		const manifestBytes = new Uint8Array(await manifestResponse.arrayBuffer());
		const manifest = JSON.parse(new TextDecoder().decode(manifestBytes)) as {
			index: Array<{ path: string; sha256: string }>;
		};

		const entries: Array<{ path: string; bytes: number; sha256: string }> = [];
		for (const ref of manifest.index) {
			const response = await call(origin, exportFileGet, { params: { id, path: ref.path } });
			const bytes = new Uint8Array(await response.arrayBuffer());
			expect(await sha256Hex(bytes)).toBe(ref.sha256);
			for (const line of new TextDecoder().decode(bytes).split("\n").filter(Boolean)) {
				entries.push(parseIndexLine(line));
			}
		}
		expect(entries.some((entry) => entry.path.startsWith("media/"))).toBe(true);
		for (const entry of entries) {
			const response = await call(origin, exportFileGet, { params: { id, path: entry.path } });
			expect(response.status).toBe(200);
			expect(response.headers.get("Content-Length")).toBe(String(entry.bytes));
			expect(response.headers.get("ETag")).toBe(`"${entry.sha256}"`);
			expect(await sha256Hex(new Uint8Array(await response.arrayBuffer()))).toBe(entry.sha256);
		}

		await expectError(
			await call(origin, exportFileGet, { params: { id, path: `media/${"0".repeat(64)}` } }),
			422,
			"TRANSFER_FILE_NOT_DECLARED",
		);
		for (const path of [
			"../manifest.json",
			"records/../manifest.json",
			"/manifest.json",
			"records%2Fentry%2F000000.ndjson",
			"_plan.json",
			"media/ABC",
		]) {
			await expectError(
				await call(origin, exportFileGet, { params: { id, path } }),
				422,
				"TRANSFER_PATH_INVALID",
			);
		}
	});

	it("fails a download whose origin media changed after the export", async () => {
		const id = (await completeExport(await startExport())).id;
		const hero = site.media.find((item) => item.id === site.ids.heroMedia)!;
		const path = `media/${await sha256Hex(hero.bytes)}`;
		const stored = origin.storage.files.get(hero.storageKey)!;
		origin.storage.files.set(hero.storageKey, {
			...stored,
			body: new Uint8Array(stored.body.byteLength).fill(7),
		});
		const response = await call(origin, exportFileGet, { params: { id, path } });
		expect(response.status).toBe(200);
		await expect(response.arrayBuffer()).rejects.toThrow();
	});

	it("round-trips the archive through unpacking, file for file", async () => {
		const { id, files } = await exportedPackage();
		expect(files.size).toBeGreaterThan(3);
		for (const [path, bytes] of files) {
			const response =
				path === MANIFEST_PATH
					? await call(origin, exportManifestGet, { params: { id } })
					: await call(origin, exportFileGet, { params: { id, path } });
			expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
		}
	});

	it("consumes an export approval only with its exact binding, once", async () => {
		const approvals = new TransferApprovalRepository(origin.db);
		const paramsDigest = await exportParamsDigest({});
		async function approved(tokenId?: string): Promise<string> {
			const pending = await requestTransferApproval(origin.db, {
				userId: ORIGIN_ADMIN.id,
				action: "export",
				paramsDigest,
				requestedByTokenId: tokenId,
			});
			const approvalId = String(pending.error.details?.approvalId);
			expect(
				(await call(origin, approvePost, { method: "POST", params: { id: approvalId } })).status,
			).toBe(200);
			return approvalId;
		}

		const unapproved = await requestTransferApproval(origin.db, {
			userId: ORIGIN_ADMIN.id,
			action: "export",
			paramsDigest,
			requestedByTokenId: "tok-1",
		});
		const denied = await handleExportCreate(origin.db, {
			userId: ORIGIN_ADMIN.id,
			options: {},
			approval: { id: String(unapproved.error.details?.approvalId), tokenId: "tok-1" },
		});
		expect(denied.success ? null : denied.error.code).toBe("TRANSFER_APPROVAL_INVALID");

		const grant = await approved("tok-1");
		for (const attempt of [
			{ userId: ORIGIN_ADMIN.id, options: {}, tokenId: "tok-2" },
			{ userId: ORIGIN_ADMIN.id, options: {} },
			{ userId: ORIGIN_ADMIN.id, options: { comments: false }, tokenId: "tok-1" },
			{ userId: "someone-else", options: {}, tokenId: "tok-1" },
		]) {
			const result = await handleExportCreate(origin.db, {
				userId: attempt.userId,
				options: attempt.options,
				approval: { id: grant, tokenId: attempt.tokenId },
			});
			expect(result.success ? null : result.error.code).toBe("TRANSFER_APPROVAL_INVALID");
		}
		const used = await handleExportCreate(origin.db, {
			userId: ORIGIN_ADMIN.id,
			options: {},
			approval: { id: grant, tokenId: "tok-1" },
		});
		expect(used.success).toBe(true);
		const replay = await handleExportCreate(origin.db, {
			userId: ORIGIN_ADMIN.id,
			options: {},
			approval: { id: grant, tokenId: "tok-1" },
		});
		expect(replay.success ? null : replay.error.code).toBe("TRANSFER_APPROVAL_INVALID");

		const expiring = await approved("tok-1");
		await origin.db
			.updateTable("_emdash_transfer_approvals")
			.set({ expires_at: "2020-01-01T00:00:00.000Z" })
			.where("id", "=", expiring)
			.execute();
		const expired = await handleExportCreate(origin.db, {
			userId: ORIGIN_ADMIN.id,
			options: {},
			approval: { id: expiring, tokenId: "tok-1" },
		});
		expect(expired.success ? null : expired.error.code).toBe("TRANSFER_APPROVAL_INVALID");
		expect((await approvals.get(expiring))?.status).toBe("approved");
	});

	it(
		"exports, downloads, uploads, analyzes, executes, and completes an import over the routes",
		{ timeout: 600_000 },
		async () => {
			const { files } = await exportedPackage();
			const target = await createTarget();
			const as = { user: TARGET_BOB };

			const manifest = files.get(MANIFEST_PATH)!;
			const created = await call(target, importsPost, {
				...as,
				method: "POST",
				body: manifest,
				headers: { "Content-Length": String(manifest.byteLength) },
			});
			expect(created.status).toBe(201);
			const importId = (await json<{ operation: PublicOperation }>(created)).data.operation.id;

			for (let round = 0; round < 10; round++) {
				const page = (
					await json<{ items: Array<{ path: string }> }>(
						await call(target, missingGet, {
							...as,
							params: { id: importId },
							query: "?limit=100",
						}),
					)
				).data.items;
				if (page.length === 0) break;
				for (const { path } of page) {
					const bytes = files.get(path)!;
					const uploaded = await call(target, filePut, {
						...as,
						method: "PUT",
						params: { id: importId, path },
						body: bytes,
						headers: { "Content-Length": String(bytes.byteLength) },
					});
					expect(uploaded.status).toBe(200);
				}
			}

			let plan: { packageDigest: string; blockers: unknown[] } | undefined;
			let planDigest: string | undefined;
			for (let step = 0; step < MAX_STEPS && !plan; step++) {
				const data = (
					await json<{
						plan?: { packageDigest: string; blockers: unknown[] };
						planDigest?: string;
						nextRequestInMs: number | null;
					}>(await call(target, analyzePost, { ...as, method: "POST", params: { id: importId } }))
				).data;
				if (data.nextRequestInMs === null) {
					plan = data.plan;
					planDigest = data.planDigest;
				}
			}
			expect(plan?.blockers).toEqual([]);

			const decided = (
				await json<{ planDigest: string }>(
					await call(target, analyzePost, {
						...as,
						method: "POST",
						params: { id: importId },
						...jsonBody({
							decisions: {
								principalMappings: { [site.ids.alice]: null, [site.ids.bob]: TARGET_BOB.id },
								siteTagline: "target",
							},
						}),
					}),
				)
			).data;
			expect(decided.planDigest).not.toBe(planDigest);

			const execute = (body: unknown, extra: Partial<CallOptions> = {}) =>
				call(target, executePost, {
					...as,
					method: "POST",
					params: { id: importId },
					...jsonBody(body),
					...extra,
				});
			await expectError(
				await execute({ packageDigest: plan!.packageDigest, planDigest: planDigest! }),
				409,
				"TRANSFER_PLAN_DIGEST_MISMATCH",
			);
			await expectError(
				await execute({ packageDigest: SHA_A, planDigest: decided.planDigest }),
				409,
				"TRANSFER_PACKAGE_DIGEST_MISMATCH",
			);
			await expectError(
				await call(target, receiptGet, { ...as, params: { id: importId } }),
				409,
				"TRANSFER_INVALID_STATE",
			);

			const pending = await requestTransferApproval(target.db, {
				userId: TARGET_BOB.id,
				action: "import",
				operationId: importId,
				packageDigest: plan!.packageDigest as Sha256Digest,
				planDigest: SHA_A,
			});
			const wrongPlanGrant = String(pending.error.details?.approvalId);
			await call(target, approvePost, { ...as, method: "POST", params: { id: wrongPlanGrant } });
			const wrongPlan = await handleImportExecute(target.db, target.storage, {
				operationId: importId,
				userId: TARGET_BOB.id,
				packageDigest: plan!.packageDigest as Sha256Digest,
				planDigest: decided.planDigest as Sha256Digest,
				approval: { id: wrongPlanGrant },
			});
			expect(wrongPlan.success ? null : wrongPlan.error.code).toBe("TRANSFER_APPROVAL_INVALID");

			const tokenGrant = await requestTransferApproval(target.db, {
				userId: TARGET_BOB.id,
				action: "import",
				operationId: importId,
				packageDigest: plan!.packageDigest as Sha256Digest,
				planDigest: decided.planDigest as Sha256Digest,
				requestedByTokenId: "tok-mcp",
			});
			const tokenGrantId = String(tokenGrant.error.details?.approvalId);
			await call(target, approvePost, { ...as, method: "POST", params: { id: tokenGrantId } });
			const wrongToken = await handleImportExecute(target.db, target.storage, {
				operationId: importId,
				userId: TARGET_BOB.id,
				packageDigest: plan!.packageDigest as Sha256Digest,
				planDigest: decided.planDigest as Sha256Digest,
				approval: { id: tokenGrantId, tokenId: "tok-other" },
			});
			expect(wrongToken.success ? null : wrongToken.error.code).toBe("TRANSFER_APPROVAL_INVALID");
			const viaGrant = await handleImportExecute(target.db, target.storage, {
				operationId: importId,
				userId: TARGET_BOB.id,
				packageDigest: plan!.packageDigest as Sha256Digest,
				planDigest: decided.planDigest as Sha256Digest,
				approval: { id: tokenGrantId, tokenId: "tok-mcp" },
			});
			expect(viaGrant.success).toBe(true);
			const replay = await handleImportExecute(target.db, target.storage, {
				operationId: importId,
				userId: TARGET_BOB.id,
				packageDigest: plan!.packageDigest as Sha256Digest,
				planDigest: decided.planDigest as Sha256Digest,
				approval: { id: tokenGrantId, tokenId: "tok-mcp" },
			});
			expect(replay.success ? null : replay.error.code).toBe("TRANSFER_APPROVAL_INVALID");

			const again = await execute({
				packageDigest: plan!.packageDigest,
				planDigest: decided.planDigest,
			});
			expect(again.status).toBe(200);

			let operation: PublicOperation | undefined;
			for (let step = 0; step < MAX_STEPS; step++) {
				const data = (
					await json<{ operation: PublicOperation; nextRequestInMs: number | null }>(
						await call(target, importAdvancePost, {
							...as,
							method: "POST",
							params: { id: importId },
						}),
					)
				).data;
				if (data.nextRequestInMs === null) {
					operation = data.operation;
					break;
				}
			}
			expect({ state: operation?.state, error: operation?.errorDetail }).toEqual({
				state: "complete",
				error: null,
			});

			const receipt = await call(target, receiptGet, {
				...as,
				params: { id: importId },
				tokenScopes: ["transfer:analyze"],
			});
			expect(receipt.status).toBe(200);
			const body = (await json<{ receipt: SiteImportReceipt }>(receipt)).data.receipt;
			expect(await verifyReceiptDigest(body)).toBe(true);
			expect(body).toMatchObject({
				operationId: importId,
				packageDigest: plan!.packageDigest,
				planDigest: decided.planDigest,
				verification: "verified",
			});
		},
	);
});
