/**
 * The site transfer MCP tools over a real MCP client/server pair: scope and
 * role gating, the one-time approval flow for starting an export or import,
 * approval binding to token and digests, bounded outputs, and exports and
 * imports driven to completion through the tools alone.
 */

import { Role, type RoleLevel } from "@emdash-cms/auth";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";

import {
	handleApprovalDecide,
	handleExportCreate,
	handleImportCreate,
	handleImportFileUpload,
	handleImportMissing,
} from "../../../src/api/handlers/transfer.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import type { PluginMcpRegistration } from "../../../src/mcp/server.js";
import { applySeed } from "../../../src/seed/apply.js";
import { defaultSeed } from "../../../src/seed/default.js";
import { MANIFEST_PATH } from "../../../src/transfer/format/paths.js";
import {
	verifyReceiptDigest,
	type SiteImportReceipt,
} from "../../../src/transfer/format/receipt.js";
import { TransferApprovalRepository } from "../../../src/transfer/ops/approvals.js";
import { TransferOperationRepository } from "../../../src/transfer/ops/operations.js";
import { connectMcpHarness, extractText, type McpHarness } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";
import { buildGoldenPackage, GOLDEN_IDS } from "../../utils/transfer/golden-package.js";
import { createMemoryStorage, type MemoryStorage } from "../../utils/transfer/memory-storage.js";
import { buildOriginSite } from "../../utils/transfer/origin-site.js";
import { seedTarget, stageGoldenImport, withFaults } from "../transfer/import/harness.js";

const ADMIN_ID = "admin-1";
const GOLDEN_PREFIX = "transfers/fixtures/golden/";
const ALL_TRANSFER_SCOPES = ["transfer:export", "transfer:analyze", "transfer:execute"];
const SHA_A = `sha256:${"a".repeat(64)}`;
const MAX_STEPS = 2000;

/** Values in the golden package that no tool output may contain. */
const GOLDEN_SENTINELS = ["alice@example.com", "Golden Site", "Bonjour le monde", "Coming soon"];

interface ToolResult {
	isError?: boolean;
	content?: Array<{ type: string; text?: string }>;
	_meta?: { code?: string; details?: Record<string, unknown> };
}

interface OperationSummary {
	id: string;
	kind: string;
	state: string;
	packageDigest: string | null;
	planDigest: string | null;
	error: { code: string } | null;
}

interface PlanSummary {
	packageDigest: string;
	planDigest: string;
	executable: boolean;
	principals: { total: number; items: Array<Record<string, unknown>> };
	blockers: { total: number };
}

describeEachDialect("site transfer MCP tools", (dialect) => {
	let ctx: DialectTestContext;
	let originCtx: DialectTestContext | undefined;
	let storage: MemoryStorage;
	let packageFiles: Map<string, Uint8Array>;
	const harnesses: McpHarness[] = [];
	/** Text of every tool result, for the leak assertions. */
	let outputs: string[];

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		await applySeed(ctx.db, defaultSeed, { includeContent: false, onConflict: "skip" });
		setI18nConfig({ defaultLocale: "en", locales: ["en", "fr"] });
		storage = createMemoryStorage();
		outputs = [];

		const source = createMemoryStorage();
		await buildGoldenPackage(source, { prefix: GOLDEN_PREFIX });
		packageFiles = new Map(
			Array.from(source.files, ([key, file]) => [key.slice(GOLDEN_PREFIX.length), file.body]),
		);
	});

	afterEach(async () => {
		await Promise.all(harnesses.splice(0).map((harness) => harness.cleanup()));
		setI18nConfig(null);
		await teardownForDialect(ctx);
		await teardownForDialect(originCtx);
		originCtx = undefined;
	});

	async function connect(
		options: {
			scopes?: string[];
			tokenId?: string;
			role?: RoleLevel;
			site?: { db: DialectTestContext["db"]; storage: MemoryStorage };
			pluginTools?: PluginMcpRegistration[];
		} = {},
	): Promise<McpHarness> {
		const site = options.site ?? { db: ctx.db, storage };
		const harness = await connectMcpHarness({
			db: site.db,
			userId: ADMIN_ID,
			userRole: options.role ?? Role.ADMIN,
			tokenScopes: options.scopes,
			tokenId: options.tokenId,
			runtimeOptions: { storage: site.storage },
			pluginTools: options.pluginTools,
		});
		harnesses.push(harness);
		return harness;
	}

	async function call(
		harness: McpHarness,
		name: string,
		args: Record<string, unknown> = {},
	): Promise<ToolResult> {
		const result = (await harness.client.callTool({ name, arguments: args })) as ToolResult;
		outputs.push(JSON.stringify(result));
		return result;
	}

	function data<T>(result: ToolResult): T {
		if (result.isError) throw new Error(`Expected success, got ${extractText(result)}`);
		return JSON.parse(extractText(result)) as T;
	}

	function code(result: ToolResult): string | null {
		return result.isError ? (result._meta?.code ?? "UNKNOWN") : null;
	}

	async function approve(approvalId: string): Promise<void> {
		const decided = await handleApprovalDecide(ctx.db, {
			approvalId,
			decision: "approve",
			user: { id: ADMIN_ID, role: Role.ADMIN },
		});
		expect(decided.success).toBe(true);
	}

	async function stagedImport(): Promise<string> {
		const created = await handleImportCreate(ctx.db, storage, {
			userId: ADMIN_ID,
			manifest: packageFiles.get(MANIFEST_PATH)!,
		});
		if (!created.success) throw new Error(created.error.message);
		const id = created.data.operation.id;
		for (let round = 0; round < 10; round++) {
			const missing = await handleImportMissing(ctx.db, id, { limit: 100 });
			if (!missing.success) throw new Error(missing.error.message);
			if (missing.data.items.length === 0) return id;
			for (const file of missing.data.items) {
				const bytes = packageFiles.get(file.path)!;
				const uploaded = await handleImportFileUpload(ctx.db, storage, {
					operationId: id,
					path: file.path,
					contentLength: bytes.byteLength,
					body: new Response(bytes).body,
					maxBlobBytes: 50 * 1024 * 1024,
				});
				if (!uploaded.success) throw new Error(uploaded.error.message);
			}
		}
		throw new Error("uploads did not converge");
	}

	async function analyzeToPlan(harness: McpHarness, id: string): Promise<PlanSummary> {
		for (let step = 0; step < MAX_STEPS; step++) {
			const result = data<{ plan?: PlanSummary; nextRequestInMs: number | null }>(
				await call(harness, "site_import_analyze", { operationId: id }),
			);
			if (result.nextRequestInMs === null) {
				if (!result.plan) throw new Error("analysis ended without a plan");
				return result.plan;
			}
		}
		throw new Error("analysis did not finish");
	}

	async function approvalCount(): Promise<number> {
		return (await new TransferApprovalRepository(ctx.db).list({ limit: 100 })).items.length;
	}

	async function stagingSecrets(): Promise<string[]> {
		const rows = await ctx.db
			.selectFrom("_emdash_transfer_operations")
			.select("staging_secret")
			.execute();
		return rows.map((row) => row.staging_secret);
	}

	function expectNoLeaks(forbidden: string[]): void {
		const text = outputs.join("\n");
		for (const value of forbidden) expect(text).not.toContain(value);
		expect(text).not.toContain("transfers/");
		expect(text).not.toContain("/_emdash/api/");
	}

	it("gates every tool on the admin role before anything else", async () => {
		const editor = await connect({
			scopes: ALL_TRANSFER_SCOPES,
			tokenId: "tok-editor",
			role: Role.EDITOR,
		});
		const id = await stagedImport();
		const calls: Array<[string, Record<string, unknown>]> = [
			["site_transfer_capabilities", {}],
			["site_export_start", {}],
			["site_export_status", { operationId: id }],
			["site_import_analyze", { operationId: id }],
			["site_import_start", { operationId: id, packageDigest: SHA_A, planDigest: SHA_A }],
			["site_import_status", { operationId: id }],
			["site_import_resume", { operationId: id }],
			["site_import_receipt", { operationId: id }],
		];
		for (const [name, args] of calls) {
			expect(code(await call(editor, name, args)), name).toBe("INSUFFICIENT_PERMISSIONS");
		}
		expect(await approvalCount()).toBe(0);
		expect((await new TransferOperationRepository(ctx.db).list({ kind: "export" })).items).toEqual(
			[],
		);
	});

	it("enforces the transfer scope matrix, with admin granting every transfer scope", async () => {
		const importId = await stagedImport();
		const exported = await handleExportCreate(ctx.db, { userId: ADMIN_ID, options: {} });
		if (!exported.success) throw new Error(exported.error.message);
		const exportId = exported.data.operation.id;

		const tools: Array<{ name: string; args: Record<string, unknown>; allowed: string[] }> = [
			{ name: "site_transfer_capabilities", args: {}, allowed: ALL_TRANSFER_SCOPES },
			{
				name: "site_export_status",
				args: { operationId: exportId, advance: false },
				allowed: ["transfer:export"],
			},
			{
				name: "site_import_analyze",
				args: { operationId: importId },
				allowed: ["transfer:analyze"],
			},
			{ name: "site_import_status", args: { operationId: importId }, allowed: ALL_TRANSFER_SCOPES },
			{
				name: "site_import_resume",
				args: { operationId: importId },
				allowed: ["transfer:execute"],
			},
			{
				name: "site_import_receipt",
				args: { operationId: importId },
				allowed: ALL_TRANSFER_SCOPES,
			},
		];
		const tokens = [
			[],
			["admin"],
			["content:write", "schema:write", "settings:manage"],
			...ALL_TRANSFER_SCOPES.map((s) => [s]),
		];
		for (const scopes of tokens) {
			const harness = await connect({ scopes, tokenId: `tok-${scopes.join("+")}` });
			for (const tool of tools) {
				const result = await call(harness, tool.name, tool.args);
				const permitted =
					scopes.includes("admin") || scopes.some((scope) => tool.allowed.includes(scope));
				const label = `${tool.name} with [${scopes.join(", ")}]`;
				if (permitted) expect(code(result), label).not.toBe("INSUFFICIENT_SCOPE");
				else expect(code(result), label).toBe("INSUFFICIENT_SCOPE");
			}
		}

		const withoutToken = await connect();
		expect(code(await call(withoutToken, "site_transfer_capabilities"))).toBe("INSUFFICIENT_SCOPE");
		expect(code(await call(withoutToken, "site_export_start"))).toBe("INSUFFICIENT_SCOPE");
		expect(await approvalCount()).toBe(0);

		const exporter = await connect({ scopes: ["transfer:export"], tokenId: "tok-export" });
		const started = data<{ operation: OperationSummary }>(
			await call(exporter, "site_export_start", { comments: false }),
		);
		expect(started.operation).toMatchObject({ kind: "export", state: "pending" });
		const capabilities = data<{ formatVersions: string[]; portableDomain: { empty: boolean } }>(
			await call(exporter, "site_transfer_capabilities"),
		);
		expect(capabilities.formatVersions).toContain("1");
		expect(await approvalCount()).toBe(0);
	});

	it("lets an admin token start an export without an approval", async () => {
		const admin = await connect({ scopes: ["admin"], tokenId: "tok-admin" });
		const started = data<{ operation: OperationSummary }>(
			await call(admin, "site_export_start", {}),
		);
		expect(started.operation).toMatchObject({ kind: "export", state: "pending" });
		expect(await approvalCount()).toBe(0);
	});

	it("starts an export only after an admin approves the exact request for the same token", async () => {
		const tokenA = await connect({
			scopes: ["content:read", "transfer:analyze"],
			tokenId: "tok-a",
		});
		const tokenB = await connect({
			scopes: ["content:read", "transfer:analyze"],
			tokenId: "tok-b",
		});

		const requested = await call(tokenA, "site_export_start", {});
		expect(code(requested)).toBe("TRANSFER_APPROVAL_REQUIRED");
		const approvalId = String(requested._meta?.details?.approvalId);
		expect(extractText(requested)).toContain(approvalId);
		expect(extractText(requested)).toContain("Settings → Transfer");

		const repeated = await call(tokenA, "site_export_start", {});
		expect(repeated._meta?.details?.approvalId).toBe(approvalId);
		expect(await approvalCount()).toBe(1);

		expect(code(await call(tokenA, "site_export_start", { approvalId }))).toBe(
			"TRANSFER_APPROVAL_INVALID",
		);
		await approve(approvalId);

		expect(code(await call(tokenB, "site_export_start", { approvalId }))).toBe(
			"TRANSFER_APPROVAL_INVALID",
		);
		expect(code(await call(tokenA, "site_export_start", { approvalId, comments: false }))).toBe(
			"TRANSFER_APPROVAL_INVALID",
		);
		const started = data<{ operation: OperationSummary }>(
			await call(tokenA, "site_export_start", { approvalId }),
		);
		expect(started.operation).toMatchObject({ kind: "export", state: "pending" });
		expect(code(await call(tokenA, "site_export_start", { approvalId }))).toBe(
			"TRANSFER_APPROVAL_INVALID",
		);
		expect(
			(await new TransferOperationRepository(ctx.db).list({ kind: "export" })).items,
		).toHaveLength(1);

		const status = await call(tokenA, "site_export_status", {
			operationId: started.operation.id,
			advance: false,
		});
		expect(data<{ operation: OperationSummary }>(status).operation.id).toBe(started.operation.id);
		expect(
			code(
				await call(tokenB, "site_export_status", {
					operationId: started.operation.id,
					advance: false,
				}),
			),
		).toBe("INSUFFICIENT_SCOPE");

		const other = await handleExportCreate(ctx.db, { userId: ADMIN_ID, options: {} });
		if (!other.success) throw new Error(other.error.message);
		expect(
			code(
				await call(tokenA, "site_export_status", {
					operationId: other.data.operation.id,
					advance: false,
				}),
			),
		).toBe("INSUFFICIENT_SCOPE");

		const denied = await call(tokenB, "site_export_start", {});
		const deniedId = String(denied._meta?.details?.approvalId);
		expect(deniedId).not.toBe(approvalId);
		const decided = await handleApprovalDecide(ctx.db, {
			approvalId: deniedId,
			decision: "deny",
			user: { id: ADMIN_ID, role: Role.ADMIN },
		});
		expect(decided.success).toBe(true);
		expect(code(await call(tokenB, "site_export_start", { approvalId: deniedId }))).toBe(
			"TRANSFER_APPROVAL_INVALID",
		);
	});

	it("analyzes, starts through an approval, resumes, and returns the receipt without leaking package data", async () => {
		const importId = await stagedImport();
		const analyst = await connect({ scopes: ["transfer:analyze"], tokenId: "tok-analyze" });
		const tokenE = await connect({
			scopes: ["content:read", "transfer:analyze"],
			tokenId: "tok-e",
		});
		const tokenF = await connect({ scopes: ["content:read"], tokenId: "tok-f" });

		const first = await analyzeToPlan(analyst, importId);
		expect(first.blockers.total).toBe(0);
		expect(first.executable).toBe(true);
		const alice = first.principals.items.find((item) => item.id === GOLDEN_IDS.alice);
		expect(alice).toMatchObject({ displayName: "Alice Author" });
		expect(alice).not.toHaveProperty("email");

		const decided = data<{ plan: PlanSummary }>(
			await call(analyst, "site_import_analyze", {
				operationId: importId,
				decisions: { principalMappings: { [GOLDEN_IDS.alice]: null }, siteTagline: "target" },
			}),
		).plan;
		expect(decided.planDigest).not.toBe(first.planDigest);
		const digests = { packageDigest: decided.packageDigest, planDigest: decided.planDigest };

		expect(
			code(
				await call(tokenE, "site_import_start", {
					operationId: importId,
					...digests,
					planDigest: first.planDigest,
				}),
			),
		).toBe("TRANSFER_PLAN_DIGEST_MISMATCH");
		expect(
			code(
				await call(tokenE, "site_import_start", {
					operationId: importId,
					...digests,
					packageDigest: SHA_A,
				}),
			),
		).toBe("TRANSFER_PACKAGE_DIGEST_MISMATCH");
		expect(await approvalCount()).toBe(0);

		const requested = await call(tokenE, "site_import_start", {
			operationId: importId,
			...digests,
		});
		expect(code(requested)).toBe("TRANSFER_APPROVAL_REQUIRED");
		const approvalId = String(requested._meta?.details?.approvalId);
		expect(code(await call(tokenE, "site_import_resume", { operationId: importId }))).toBe(
			"INSUFFICIENT_SCOPE",
		);
		await approve(approvalId);

		expect(
			code(
				await call(tokenF, "site_import_start", { operationId: importId, ...digests, approvalId }),
			),
		).toBe("TRANSFER_APPROVAL_INVALID");
		expect(
			code(
				await call(tokenE, "site_import_start", {
					operationId: importId,
					...digests,
					planDigest: first.planDigest,
					approvalId,
				}),
			),
		).toBe("TRANSFER_PLAN_DIGEST_MISMATCH");
		expect((await new TransferApprovalRepository(ctx.db).get(approvalId))?.status).toBe("approved");

		const started = data<{ operation: OperationSummary }>(
			await call(tokenE, "site_import_start", { operationId: importId, ...digests, approvalId }),
		);
		expect(started.operation).toMatchObject({ id: importId, ...digests });
		expect(
			code(
				await call(tokenE, "site_import_start", { operationId: importId, ...digests, approvalId }),
			),
		).toBe("TRANSFER_APPROVAL_INVALID");

		expect(code(await call(tokenF, "site_import_resume", { operationId: importId }))).toBe(
			"INSUFFICIENT_SCOPE",
		);
		expect(code(await call(tokenF, "site_import_status", { operationId: importId }))).toBe(
			"INSUFFICIENT_SCOPE",
		);

		const writer = await connect({ scopes: ["admin"], tokenId: "tok-writer" });
		// One failed media write leaves the import running mid-way, and fenced.
		let failedUpload = false;
		storage.beforeUpload = (key) => {
			if (failedUpload || key.startsWith("transfers/")) return;
			failedUpload = true;
			throw new Error("storage unavailable");
		};
		let finished: OperationSummary | undefined;
		let checkedFence = false;
		for (let step = 0; step < MAX_STEPS && !finished; step++) {
			const result = data<{ operation: OperationSummary; nextRequestInMs: number | null }>(
				await call(tokenE, "site_import_resume", { operationId: importId }),
			);
			if (result.nextRequestInMs === null) finished = result.operation;
			else if (!checkedFence && result.operation.state === "running") {
				checkedFence = true;
				const refused = await call(writer, "content_create", {
					collection: "posts",
					data: { title: "During import" },
				});
				expect(code(refused)).toBe("TRANSFER_IMPORT_IN_PROGRESS");
				expect(code(await call(writer, "content_list", { collection: "posts" }))).not.toBe(
					"TRANSFER_IMPORT_IN_PROGRESS",
				);
				expect(code(await call(writer, "schema_list_collections"))).toBeNull();
				expect(
					code(await call(tokenE, "site_import_status", { operationId: importId })),
				).toBeNull();
			}
		}
		expect(checkedFence).toBe(true);
		expect({ state: finished?.state, error: finished?.error }).toEqual({
			state: "complete",
			error: null,
		});

		const status = data<{ operation: OperationSummary; files: { declared: number } }>(
			await call(tokenE, "site_import_status", { operationId: importId }),
		);
		expect(status.operation.state).toBe("complete");
		expect(status.files.declared).toBe(0);

		const { receipt } = data<{ receipt: SiteImportReceipt }>(
			await call(tokenE, "site_import_receipt", { operationId: importId }),
		);
		expect(receipt).toMatchObject({ operationId: importId, ...digests, verification: "verified" });
		expect(await verifyReceiptDigest(receipt)).toBe(true);

		expectNoLeaks([...GOLDEN_SENTINELS, ...(await stagingSecrets())]);
	});

	it("refuses new decisions once an approved import has started", async () => {
		const importId = await stagedImport();
		const analyst = await connect({ scopes: ["transfer:analyze"], tokenId: "tok-analyze" });
		const starter = await connect({ scopes: ["content:read"], tokenId: "tok-start" });
		const plan = await analyzeToPlan(analyst, importId);
		const digests = { packageDigest: plan.packageDigest, planDigest: plan.planDigest };

		const requested = await call(starter, "site_import_start", {
			operationId: importId,
			...digests,
		});
		const approvalId = String(requested._meta?.details?.approvalId);
		await approve(approvalId);
		expect(
			code(
				await call(starter, "site_import_start", { operationId: importId, ...digests, approvalId }),
			),
		).toBeNull();

		expect(
			code(
				await call(analyst, "site_import_analyze", {
					operationId: importId,
					decisions: { principalMappings: { [GOLDEN_IDS.alice]: null }, siteTitle: "target" },
				}),
			),
		).toBe("TRANSFER_INVALID_STATE");
		const status = data<{ operation: OperationSummary }>(
			await call(starter, "site_import_status", { operationId: importId }),
		);
		expect(status.operation.planDigest).toBe(plan.planDigest);
	});

	it("asks site_import_resume callers to retry when another caller takes the lease", async () => {
		await seedTarget(ctx.db);
		const staged = await stageGoldenImport(ctx.db, storage, dialect);
		const { db, faults } = withFaults(ctx.db);
		faults.afterCheckpoint = async () => {
			faults.afterCheckpoint = null;
			await ctx.db
				.updateTable("_emdash_transfer_operations")
				.set({ lease_token: "another-caller", lease_expires_at: "2999-01-01T00:00:00.000Z" })
				.where("id", "=", staged.operationId)
				.execute();
		};
		const harness = await connect({
			scopes: ["transfer:execute"],
			tokenId: "tok-execute",
			site: { db, storage },
		});
		const result = data<{ operation: OperationSummary; nextRequestInMs: number | null }>(
			await call(harness, "site_import_resume", { operationId: staged.operationId }),
		);
		expect(result.nextRequestInMs).toBeGreaterThan(0);
		expect(result.operation.error).toBeNull();
		expect(result.operation.state).not.toBe("failed");
	});

	it("drives an export to completion through repeated status calls", async () => {
		originCtx = await setupForDialect(dialect);
		const originStorage = createMemoryStorage();
		const site = await buildOriginSite(originCtx.db, originStorage);
		const harness = await connect({
			scopes: ["transfer:export"],
			tokenId: "tok-export",
			site: { db: originCtx.db, storage: originStorage },
		});

		const { operation } = data<{ operation: OperationSummary }>(
			await call(harness, "site_export_start", {}),
		);
		let finished:
			| {
					operation: OperationSummary;
					totals?: {
						records: { total: number; byKind: Record<string, number> };
						media: { count: number };
					};
			  }
			| undefined;
		let steps = 0;
		for (; steps < MAX_STEPS && !finished; steps++) {
			const result = data<{
				operation: OperationSummary;
				nextRequestInMs: number | null;
			}>(await call(harness, "site_export_status", { operationId: operation.id }));
			if (result.nextRequestInMs === null) finished = result;
		}
		expect(steps).toBeGreaterThan(1);
		expect(finished?.operation).toMatchObject({ state: "complete", error: null });
		const stored = await new TransferOperationRepository(originCtx.db).require(operation.id);
		expect(finished?.operation.packageDigest).toBe(stored.packageDigest);
		expect(finished?.operation.packageDigest).toMatch(/^sha256:[0-9a-f]{64}$/);
		expect(finished?.totals?.records.byKind.entry).toBeGreaterThan(0);
		expect(finished?.totals?.media.count).toBeGreaterThan(0);

		const reread = data<{ operation: OperationSummary; nextRequestInMs: number | null }>(
			await call(harness, "site_export_status", { operationId: operation.id }),
		);
		expect(reread).toMatchObject({ operation: { state: "complete" }, nextRequestInMs: null });

		expectNoLeaks([
			...site.forbidden,
			...site.media.map((item) => item.storageKey),
			stored.stagingSecret,
		]);
	});

	async function operationInState(kind: "import" | "export", state: string): Promise<string> {
		const { operation } = await new TransferOperationRepository(ctx.db).create({
			kind,
			createdBy: ADMIN_ID,
		});
		await ctx.db
			.updateTable("_emdash_transfer_operations")
			.set({ state, mutation_started_at: kind === "import" ? "2026-01-01T00:00:00.000Z" : null })
			.where("id", "=", operation.id)
			.execute();
		return operation.id;
	}

	async function writeEpoch(id: string): Promise<number> {
		return (await new TransferOperationRepository(ctx.db).require(id)).writeEpoch;
	}

	it("fences plugin tools during an import without dispatching them", async () => {
		const pluginTool: PluginMcpRegistration = {
			pluginId: "fenced-plugin",
			name: "sync",
			description: "Sync records",
			route: "sync",
			permission: "content:read",
			destructive: false,
			inputSchema: z.object({}),
		};
		const harness = await connect({
			scopes: ["mcp:tools:fenced-plugin"],
			tokenId: "tok-plugin",
			pluginTools: [pluginTool],
		});
		const dispatched = vi.fn(async () => ({ success: true as const, data: { ok: true } }));
		harness.handlers.handlePluginMcpTool = dispatched;

		expect(code(await call(harness, "fenced-plugin__sync"))).toBeNull();
		expect(dispatched).toHaveBeenCalledTimes(1);

		await operationInState("import", "failed");
		expect(code(await call(harness, "fenced-plugin__sync"))).toBe("TRANSFER_IMPORT_IN_PROGRESS");
		expect(dispatched).toHaveBeenCalledTimes(1);
	});

	it("refuses write tools while media usage activation is in progress", async () => {
		const harness = await connect({ scopes: ["admin"], tokenId: "tok-admin" });
		await ctx.db
			.updateTable("_emdash_media_usage_activation")
			.set({ state: "activating" })
			.where("task_key", "=", "incremental_capture")
			.execute();

		const refused = await call(harness, "content_create", {
			collection: "posts",
			data: { title: "During activation" },
		});
		expect(code(refused)).toBe("MEDIA_USAGE_ACTIVATION_IN_PROGRESS");
		const listed = data<{ items: unknown[] }>(
			await call(harness, "content_list", { collection: "posts" }),
		);
		expect(listed.items).toEqual([]);
	});

	it("bumps a running export's write epoch for write tools only", async () => {
		const harness = await connect({ scopes: ["admin"], tokenId: "tok-admin" });
		const exportId = await operationInState("export", "running");

		expect(code(await call(harness, "content_list", { collection: "posts" }))).toBeNull();
		expect(await writeEpoch(exportId)).toBe(0);

		expect(
			code(
				await call(harness, "content_create", {
					collection: "posts",
					data: { title: "Written during export" },
				}),
			),
		).toBeNull();
		expect(await writeEpoch(exportId)).toBe(1);

		expect(
			code(
				await call(harness, "content_create", {
					collection: "no_such_collection",
					data: { title: "Refused" },
				}),
			),
		).not.toBeNull();
		expect(await writeEpoch(exportId)).toBe(1);
	});
});
