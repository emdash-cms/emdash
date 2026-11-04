/**
 * Site transfer API client: exports, staged imports, and MCP approval grants.
 */

import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { API_BASE, apiFetch, parseApiResponse, throwResponseError } from "./client.js";

const TRANSFER_BASE = `${API_BASE}/admin/transfer`;

// =============================================================================
// Types
// =============================================================================

export type Sha256Digest = `sha256:${string}`;

export type ExportState = "pending" | "running" | "complete" | "failed" | "expired";

export type ImportState =
	| "uploading"
	| "analyzing"
	| "planned"
	| "running"
	| "verifying"
	| "complete"
	| "failed"
	| "cancelled"
	| "abandoned"
	| "expired";

export interface TransferProgress {
	done: number;
	total: number;
	records?: number;
	bytesDone?: number;
	bytesTotal?: number;
}

export interface TransferOperation {
	id: string;
	kind: "export" | "import";
	state: ExportState | ImportState;
	stage: string | null;
	cursor: unknown;
	progress: TransferProgress | null;
	options: unknown;
	idempotencyKey: string | null;
	packageDigest: Sha256Digest | null;
	planDigest: Sha256Digest | null;
	originSiteId: string | null;
	receipt: SiteImportReceipt | null;
	errorCode: string | null;
	errorDetail: Record<string, unknown> | null;
	writeEpoch: number;
	attemptCount: number;
	leaseExpiresAt: string | null;
	runtimeGeneration: number;
	cancelRequestedAt: string | null;
	mutationStartedAt: string | null;
	createdBy: string;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
	expiresAt: string | null;
	stagingCollectedAt: string | null;
}

export type PortableDomainBlocker =
	| { code: "table_not_empty"; table: string }
	| { code: "collection_not_seeded"; id: string; slug: string }
	| { code: "block_type_not_seeded"; id: string; slug: string }
	| { code: "collection_has_entries"; id: string; slug: string }
	| { code: "taxonomy_def_not_scaffold"; id: string; name: string };

export interface TransferCapabilities {
	formatVersions: string[];
	features: string[];
	optionalFeatures: string[];
	limits: {
		manifestBytes: number;
		recordLineBytes: number;
		chunkBytes: number;
		chunkRecords: number;
		totalRecords: number;
		totalFiles: number;
		indexChunks: number;
		jsonDepth: number;
		maxBlobBytes: number;
	};
	portableDomain: {
		empty: boolean;
		blockers: PortableDomainBlocker[];
		seededScaffold: ScaffoldItem[];
	};
}

/** Starter content a site was set up with, which an import removes. */
export type ScaffoldItem =
	| { type: "collection"; id: string; slug: string }
	| { type: "term"; id: string; name: string; slug: string; locale: string }
	| { type: "taxonomy_def"; id: string; name: string; locale: string }
	| { type: "menu_item"; id: string; menuId: string; label: string }
	| { type: "menu"; id: string; name: string; locale: string }
	| { type: "widget"; id: string; areaId: string; widgetType: string }
	| { type: "widget_area"; id: string; name: string }
	| { type: "section"; id: string; slug: string }
	| { type: "block_type"; id: string; slug: string };

export interface TransferPage<T> {
	items: T[];
	nextCursor?: string;
}

export interface MissingFile {
	path: string;
	bytes: number;
	sha256: string;
}

export interface PlanIssue {
	code: string;
	message: string;
	kind?: string;
	id?: string;
	count?: number;
	detail?: Record<string, string | number | boolean | null>;
}

export interface PlanPrincipal {
	id: string;
	displayName: string;
	email?: string;
	references: number;
	suggestedUserId?: string;
}

export type SettingChoice = "package" | "target";

export interface SiteImportDecisions {
	principalMappings: Record<string, string | null>;
	siteTitle: SettingChoice;
	siteTagline: SettingChoice;
}

export interface SiteImportPlan {
	formatVersion: string;
	packageDigest: Sha256Digest;
	origin: {
		siteId: string;
		packageId: string;
		createdAt: string;
		createdByEmDashVersion: string;
	};
	target: {
		siteId: string;
		dialect: "sqlite" | "postgres";
		emdashVersion: string;
	};
	counts: Partial<Record<string, number>>;
	bytes: { records: number; media: number };
	principals: PlanPrincipal[];
	settings: {
		title: { package?: string; target?: string };
		tagline: { package?: string; target?: string };
	};
	decisions: SiteImportDecisions;
	transformations: Array<{
		code: string;
		count?: number;
		kind?: string;
		/** Present for `seeded_scaffold_removed`: the scaffold rows the import deletes. */
		items?: Array<{ type: string; id: string }>;
		/** The records a per-record transformation applies to. */
		ids?: string[];
		/** Present for `locale_recased`: each package locale and the target spelling it becomes. */
		locales?: Array<{ from: string; to: string }>;
	}>;
	warnings: PlanIssue[];
	blockers: PlanIssue[];
	estimatedSteps: number;
}

export interface SiteImportReceipt {
	operationId: string;
	packageDigest: Sha256Digest;
	planDigest: Sha256Digest;
	targetSiteId: string;
	originSiteId: string;
	formatVersion: string;
	importerEmDashVersion: string;
	completedAt: string;
	logicalDigest: Sha256Digest;
	counts: Record<string, number>;
	warnings: Array<{ code: string; message: string }>;
	verification: "verified";
	receiptDigest: Sha256Digest;
}

/** The subset of `manifest.json` the admin reads. */
export interface SitePackageManifestSummary {
	packageId: string;
	originSiteId: string;
	createdAt: string;
	createdByEmDashVersion: string;
	records: Partial<Record<string, { count: number; chunks: number }>>;
	media: { count: number; totalBytes: number };
	files: { count: number; totalBytes: number };
	index: Array<{ path: string; bytes: number; sha256: string; entries: number }>;
}

export interface AdvanceResult {
	operation: TransferOperation;
	nextRequestInMs: number | null;
}

export interface AnalyzeResult extends AdvanceResult {
	plan?: SiteImportPlan;
	planDigest?: Sha256Digest;
}

export interface CreateImportResult {
	operation: TransferOperation;
	created: boolean;
	missing: TransferPage<MissingFile>;
}

export type ApprovalStatus = "pending" | "approved" | "denied" | "consumed" | "expired";

export interface TransferApproval {
	id: string;
	status: ApprovalStatus;
	action: "export" | "import";
	userId: string;
	requestedByTokenId: string | null;
	approvedBy: string | null;
	operationId: string | null;
	paramsDigest: Sha256Digest | null;
	packageDigest: Sha256Digest | null;
	planDigest: Sha256Digest | null;
	expiresAt: string;
	createdAt: string;
	decidedAt: string | null;
	consumedAt: string | null;
}

export const TRANSFER_CAPABILITIES_QUERY_KEY = ["transfer", "capabilities"] as const;
export const TRANSFER_EXPORTS_QUERY_KEY = ["transfer", "exports"] as const;
export const TRANSFER_IMPORTS_QUERY_KEY = ["transfer", "imports"] as const;
export const TRANSFER_APPROVALS_QUERY_KEY = ["transfer", "approvals"] as const;

function pageQuery(options: { cursor?: string; limit?: number } = {}): string {
	const params = new URLSearchParams();
	if (options.cursor) params.set("cursor", options.cursor);
	if (options.limit) params.set("limit", String(options.limit));
	const query = params.toString();
	return query ? `?${query}` : "";
}

function operationUrl(kind: "exports" | "imports", id: string, suffix = ""): string {
	return `${TRANSFER_BASE}/${kind}/${encodeURIComponent(id)}${suffix}`;
}

function encodePackagePath(path: string): string {
	return path.split("/").map(encodeURIComponent).join("/");
}

function postJson(url: string, body?: unknown, headers?: Record<string, string>) {
	return apiFetch(url, {
		method: "POST",
		headers: { "Content-Type": "application/json", ...headers },
		body: JSON.stringify(body ?? {}),
	});
}

// =============================================================================
// Capabilities
// =============================================================================

export async function fetchTransferCapabilities(): Promise<TransferCapabilities> {
	const res = await apiFetch(`${TRANSFER_BASE}/capabilities`);
	return parseApiResponse<TransferCapabilities>(
		res,
		i18n._(msg`Failed to load transfer capabilities`),
	);
}

// =============================================================================
// Exports
// =============================================================================

export async function fetchTransferExports(
	options: { cursor?: string; limit?: number } = {},
): Promise<TransferPage<TransferOperation>> {
	const res = await apiFetch(`${TRANSFER_BASE}/exports${pageQuery(options)}`);
	return parseApiResponse<TransferPage<TransferOperation>>(
		res,
		i18n._(msg`Failed to load exports`),
	);
}

/**
 * Start an export. Retrying with the same `idempotencyKey` returns the
 * export the first request started instead of starting another.
 */
export async function createTransferExport(options: {
	comments: boolean;
	idempotencyKey: string;
}): Promise<TransferOperation> {
	const res = await postJson(
		`${TRANSFER_BASE}/exports`,
		{ comments: options.comments },
		{ "Idempotency-Key": options.idempotencyKey },
	);
	const data = await parseApiResponse<{ operation: TransferOperation }>(
		res,
		i18n._(msg`Failed to start export`),
	);
	return data.operation;
}

export async function advanceTransferExport(id: string): Promise<AdvanceResult> {
	const res = await apiFetch(operationUrl("exports", id, "/advance"), { method: "POST" });
	return parseApiResponse<AdvanceResult>(res, i18n._(msg`Failed to continue export`));
}

export async function fetchTransferExportManifest(id: string): Promise<SitePackageManifestSummary> {
	const res = await apiFetch(operationUrl("exports", id, "/manifest"));
	if (!res.ok) await throwResponseError(res, i18n._(msg`Failed to load export manifest`));
	const manifest: SitePackageManifestSummary = await res.json();
	return manifest;
}

async function fetchBytes(url: string, fallback: string, signal?: AbortSignal) {
	const res = await apiFetch(url, { signal });
	if (!res.ok) await throwResponseError(res, fallback);
	return new Uint8Array(await res.arrayBuffer());
}

/** The export's `manifest.json`, byte for byte. */
export function fetchTransferExportManifestBytes(
	id: string,
	signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
	return fetchBytes(
		operationUrl("exports", id, "/manifest"),
		i18n._(msg`Failed to load export manifest`),
		signal,
	);
}

/** One file of a complete export: an index or record chunk, or a media blob. */
export function fetchTransferExportFile(
	id: string,
	path: string,
	signal?: AbortSignal,
): Promise<Uint8Array<ArrayBuffer>> {
	return fetchBytes(
		operationUrl("exports", id, `/files/${encodePackagePath(path)}`),
		i18n._(msg`Failed to download a package file`),
		signal,
	);
}

/** Plain GET with the session cookie; the response is an attachment. */
export function transferExportArchiveUrl(id: string): string {
	return operationUrl("exports", id, "/archive");
}

// =============================================================================
// Imports
// =============================================================================

export async function fetchTransferImports(
	options: { cursor?: string; limit?: number } = {},
): Promise<TransferPage<TransferOperation>> {
	const res = await apiFetch(`${TRANSFER_BASE}/imports${pageQuery(options)}`);
	return parseApiResponse<TransferPage<TransferOperation>>(
		res,
		i18n._(msg`Failed to load imports`),
	);
}

export async function fetchTransferImport(
	id: string,
): Promise<{ operation: TransferOperation; files: { declared: number; verified: number } }> {
	const res = await apiFetch(operationUrl("imports", id));
	return parseApiResponse(res, i18n._(msg`Failed to load import`));
}

/**
 * Create an import from the package's `manifest.json` bytes. Sending the
 * package digest as the idempotency key returns the existing import when the
 * same package is chosen again.
 */
export async function createTransferImport(
	manifest: Uint8Array<ArrayBuffer>,
	idempotencyKey: string,
): Promise<CreateImportResult> {
	const res = await apiFetch(`${TRANSFER_BASE}/imports`, {
		method: "POST",
		headers: { "Content-Type": "application/json", "Idempotency-Key": idempotencyKey },
		body: new Blob([manifest], { type: "application/json" }),
	});
	return parseApiResponse<CreateImportResult>(res, i18n._(msg`Failed to start import`));
}

export async function fetchTransferImportMissing(
	id: string,
	options: { cursor?: string; limit?: number } = {},
): Promise<TransferPage<MissingFile>> {
	const res = await apiFetch(operationUrl("imports", id, `/missing${pageQuery(options)}`));
	return parseApiResponse<TransferPage<MissingFile>>(
		res,
		i18n._(msg`Failed to list files to upload`),
	);
}

export async function uploadTransferImportFile(
	id: string,
	path: string,
	body: Uint8Array<ArrayBuffer>,
	signal?: AbortSignal,
): Promise<{ path: string; bytes: number; alreadyVerified: boolean; remaining: number }> {
	const res = await apiFetch(operationUrl("imports", id, `/files/${encodePackagePath(path)}`), {
		method: "PUT",
		headers: { "Content-Type": "application/octet-stream" },
		body: new Blob([body]),
		signal,
	});
	return parseApiResponse(res, i18n._(msg`Failed to upload a package file`));
}

export async function analyzeTransferImport(
	id: string,
	decisions?: SiteImportDecisions,
): Promise<AnalyzeResult> {
	const res = await postJson(
		operationUrl("imports", id, "/analyze"),
		decisions ? { decisions } : {},
	);
	return parseApiResponse<AnalyzeResult>(res, i18n._(msg`Failed to analyze import`));
}

export async function fetchTransferImportPlan(
	id: string,
): Promise<{ plan: SiteImportPlan; planDigest: Sha256Digest }> {
	const res = await apiFetch(operationUrl("imports", id, "/plan"));
	return parseApiResponse(res, i18n._(msg`Failed to load import plan`));
}

export async function executeTransferImport(
	id: string,
	digests: { packageDigest: Sha256Digest; planDigest: Sha256Digest },
): Promise<TransferOperation> {
	const res = await postJson(operationUrl("imports", id, "/execute"), digests);
	const data = await parseApiResponse<{ operation: TransferOperation }>(
		res,
		i18n._(msg`Failed to start import`),
	);
	return data.operation;
}

export async function advanceTransferImport(id: string): Promise<AdvanceResult> {
	const res = await apiFetch(operationUrl("imports", id, "/advance"), { method: "POST" });
	return parseApiResponse<AdvanceResult>(res, i18n._(msg`Failed to continue import`));
}

export async function fetchTransferImportReceipt(id: string): Promise<SiteImportReceipt> {
	const res = await apiFetch(operationUrl("imports", id, "/receipt"));
	const data = await parseApiResponse<{ receipt: SiteImportReceipt }>(
		res,
		i18n._(msg`Failed to load import receipt`),
	);
	return data.receipt;
}

export async function cancelTransferImport(id: string): Promise<TransferOperation> {
	const res = await apiFetch(operationUrl("imports", id, "/cancel"), { method: "POST" });
	const data = await parseApiResponse<{ operation: TransferOperation }>(
		res,
		i18n._(msg`Failed to cancel import`),
	);
	return data.operation;
}

export async function abandonTransferImport(id: string): Promise<TransferOperation> {
	const res = await apiFetch(operationUrl("imports", id, "/abandon"), { method: "POST" });
	const data = await parseApiResponse<{ operation: TransferOperation }>(
		res,
		i18n._(msg`Failed to abandon import`),
	);
	return data.operation;
}

// =============================================================================
// Approvals
// =============================================================================

export async function fetchTransferApprovals(
	options: { status?: ApprovalStatus; cursor?: string; limit?: number } = {},
): Promise<TransferPage<TransferApproval>> {
	const params = new URLSearchParams();
	if (options.status) params.set("status", options.status);
	if (options.cursor) params.set("cursor", options.cursor);
	if (options.limit) params.set("limit", String(options.limit));
	const query = params.toString();
	const res = await apiFetch(`${TRANSFER_BASE}/approvals${query ? `?${query}` : ""}`);
	return parseApiResponse<TransferPage<TransferApproval>>(
		res,
		i18n._(msg`Failed to load approval requests`),
	);
}

export async function decideTransferApproval(
	id: string,
	decision: "approve" | "deny",
): Promise<TransferApproval> {
	const res = await apiFetch(`${TRANSFER_BASE}/approvals/${encodeURIComponent(id)}/${decision}`, {
		method: "POST",
	});
	const data = await parseApiResponse<{ approval: TransferApproval }>(
		res,
		decision === "approve"
			? i18n._(msg`Failed to approve request`)
			: i18n._(msg`Failed to deny request`),
	);
	return data.approval;
}
