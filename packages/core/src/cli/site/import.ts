/**
 * `emdash site import`: verify a local package, upload what the target is
 * missing, analyze it into a plan, and execute a confirmed plan.
 *
 * Every step is resumable. The import is created with the package digest as
 * its idempotency key and found again by digest, uploads skip files the
 * target already verified, and analysis and execution are server-side state
 * machines the CLI only advances.
 */

import {
	EmDashApiError,
	type EmDashClient,
	type SiteImportDecisionsInput,
	type SiteImportPlan,
	type SiteImportReceipt,
	type TransferOperation,
	type TransferPackageFile,
} from "../../client/index.js";
import { unpackSitePackage } from "../../transfer/container/tar.js";
import { verifyReceiptDigest } from "../../transfer/format/receipt.js";
import {
	assertFileMatches,
	openArchive,
	readBody,
	scanSitePackage,
	type ScannedSitePackage,
} from "./archive.js";
import {
	createProgressLogger,
	formatBytes,
	formatProgress,
	operationError,
	SiteTransferCliError,
	sleepFor,
	withRetry,
	type TransferRuntime,
} from "./shared.js";

const UPLOAD_CONCURRENCY = 4;
/** Buffered upload bytes allowed in flight; one larger file may exceed it. */
const UPLOAD_BUFFER_BYTES = 64 * 1024 * 1024;
const MISSING_PAGE = 100;
const IMPORT_LOOKUP_PAGES = 5;
const SHA256_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

const ENDED_WITHOUT_RECEIPT = new Set(["failed", "cancelled", "abandoned", "expired"]);

/** Whether an import is executing: requested (`planned` at stage `reserve`), running, or verifying. */
export function isExecuting(operation: Pick<TransferOperation, "state" | "stage">): boolean {
	return (
		operation.state === "running" ||
		operation.state === "verifying" ||
		(operation.state === "planned" && operation.stage === "reserve")
	);
}

/** Normalize a plan digest given as `sha256:<hex>` or bare hex. */
export function normalizePlanDigest(value: string): string {
	const trimmed = value.trim().toLowerCase();
	if (SHA256_DIGEST_PATTERN.test(trimmed)) return trimmed;
	if (SHA256_HEX_PATTERN.test(trimmed)) return `sha256:${trimmed}`;
	throw new SiteTransferCliError(
		"INVALID_ARGUMENT",
		"--plan must be a plan digest like sha256:<64 hex characters>",
	);
}

// ── Finding or creating the import ─────────────────────────────

async function findImportByDigest(
	client: EmDashClient,
	digest: string,
	runtime: TransferRuntime,
): Promise<TransferOperation | null> {
	let cursor: string | undefined;
	for (let page = 0; page < IMPORT_LOOKUP_PAGES; page++) {
		const result = await withRetry(runtime, "Listing imports", () =>
			client.transferImportList({ limit: 100, cursor }),
		);
		const match = result.items.find((item) => item.packageDigest === digest);
		if (match) return ENDED_WITHOUT_RECEIPT.has(match.state) ? null : match;
		if (!result.nextCursor) return null;
		cursor = result.nextCursor;
	}
	return null;
}

/** Import states that keep blocking site writes once the import has written. */
const BLOCKING_AFTER_WRITE = new Set(["failed", "cancelled"]);

function occupiesTarget(operation: TransferOperation): boolean {
	if (!ENDED_WITHOUT_RECEIPT.has(operation.state) && operation.state !== "complete") return true;
	return operation.mutationStartedAt !== null && BLOCKING_AFTER_WRITE.has(operation.state);
}

/**
 * When the site refuses a new import because an earlier import wrote to it
 * and then stopped, say which import and what to do about it; otherwise
 * return `error` unchanged.
 */
async function explainOccupiedTarget(
	client: EmDashClient,
	error: unknown,
	runtime: TransferRuntime,
): Promise<unknown> {
	if (
		!(error instanceof EmDashApiError) ||
		(error.code !== "TRANSFER_TARGET_NOT_EMPTY" && error.code !== "TRANSFER_IMPORT_IN_PROGRESS")
	) {
		return error;
	}
	const { items } = await withRetry(runtime, "Listing imports", () =>
		client.transferImportList({ limit: 100 }),
	).catch(() => ({ items: [] as TransferOperation[] }));
	const occupying = items.find(occupiesTarget);
	if (occupying) {
		if (!BLOCKING_AFTER_WRITE.has(occupying.state)) return error;
		const ended = occupying.state === "failed" ? "failed" : "was cancelled";
		return new SiteTransferCliError(
			error.code,
			`Import ${occupying.id} ${ended} after it started writing, so this site holds partial data from it and blocks writes. Abandon it with \`emdash site import abandon ${occupying.id}\`, then reset this site or set up a new one before importing again.`,
			{ operationId: occupying.id, state: occupying.state },
		);
	}
	const abandoned = items.find(
		(item) => item.state === "abandoned" && item.mutationStartedAt !== null,
	);
	if (error.code === "TRANSFER_TARGET_NOT_EMPTY" && abandoned) {
		return new SiteTransferCliError(
			error.code,
			`Import ${abandoned.id} wrote partial data to this site before it was abandoned. Reset this site or set up a new one before importing again.`,
			{ operationId: abandoned.id, state: abandoned.state },
		);
	}
	return error;
}

export interface OpenedImport {
	operation: TransferOperation;
	/** True when every package file still has to be uploaded. */
	fresh: boolean;
}

/**
 * Find the import of this package on the target, or create it. An earlier
 * import of the same package that ended without a receipt is left alone and
 * a new one is started.
 */
export async function openImport(
	client: EmDashClient,
	scan: ScannedSitePackage,
	runtime: TransferRuntime,
): Promise<OpenedImport> {
	const existing = await findImportByDigest(client, scan.packageDigest, runtime);
	if (existing) {
		runtime.reporter.info(`Resuming import ${existing.id} (${existing.state})`);
		return { operation: existing, fresh: false };
	}
	const create = (idempotencyKey: string) =>
		withRetry(runtime, "Creating the import", () =>
			client.transferImportCreate(scan.manifestBytes, { idempotencyKey }),
		).catch(async (error: unknown) => {
			throw await explainOccupiedTarget(client, error, runtime);
		});
	let created = await create(scan.packageDigest);
	if (ENDED_WITHOUT_RECEIPT.has(created.operation.state)) {
		runtime.reporter.warn(
			`An earlier import of this package (${created.operation.id}) ended as ${created.operation.state}; starting a new one.`,
		);
		created = await create(`${scan.packageDigest}/${Date.now().toString(36)}`);
	}
	runtime.reporter.info(
		`${created.created ? "Created" : "Resuming"} import ${created.operation.id} (${created.operation.state})`,
	);
	return { operation: created.operation, fresh: created.created };
}

// ── Uploading ──────────────────────────────────────────────────

async function listMissing(
	client: EmDashClient,
	operationId: string,
	runtime: TransferRuntime,
): Promise<TransferPackageFile[]> {
	const files: TransferPackageFile[] = [];
	let cursor: string | undefined;
	do {
		const page = await withRetry(runtime, "Listing missing files", () =>
			client.transferImportMissing(operationId, { limit: MISSING_PAGE, cursor }),
		);
		files.push(...page.items);
		cursor = page.nextCursor;
	} while (cursor);
	return files;
}

class UploadPool {
	private readonly inFlight = new Set<Promise<void>>();
	private bytes = 0;
	private failure: unknown;

	constructor(
		private readonly concurrency: number,
		private readonly maxBytes: number,
	) {}

	async add(size: number, task: () => Promise<void>): Promise<void> {
		while (
			this.inFlight.size > 0 &&
			(this.inFlight.size >= this.concurrency || this.bytes + size > this.maxBytes)
		) {
			await Promise.race(this.inFlight);
		}
		this.rethrow();
		this.bytes += size;
		const promise: Promise<void> = task()
			.catch((error: unknown) => {
				this.failure ??= error;
			})
			.finally(() => {
				this.bytes -= size;
				this.inFlight.delete(promise);
			});
		this.inFlight.add(promise);
	}

	async drain(): Promise<void> {
		await Promise.all(this.inFlight);
		this.rethrow();
	}

	/** Wait for uploads in flight without surfacing their failures. */
	async settle(): Promise<void> {
		await Promise.allSettled(this.inFlight);
	}

	private rethrow(): void {
		if (this.failure !== undefined) throw this.failure;
	}
}

export interface UploadSummary {
	uploaded: number;
	bytes: number;
}

/**
 * Upload every package file the import has not verified yet. Index chunks go
 * first because uploading one declares the files it lists; a file whose
 * index chunk is not uploaded yet waits for the next pass over the archive.
 */
export async function uploadPackage(
	client: EmDashClient,
	archivePath: string,
	scan: ScannedSitePackage,
	operation: OpenedImport,
	runtime: TransferRuntime,
): Promise<UploadSummary> {
	const operationId = operation.operation.id;
	const progress = createProgressLogger(runtime);
	const summary: UploadSummary = { uploaded: 0, bytes: 0 };
	let pending: Set<string> | null = operation.fresh ? new Set(scan.files.keys()) : null;

	for (;;) {
		if (!pending) {
			const missing = await listMissing(client, operationId, runtime);
			for (const file of missing) {
				const local = scan.files.get(file.path);
				if (!local) {
					throw new SiteTransferCliError(
						"TRANSFER_FILE_MISSING",
						`The site expects ${file.path}, which is not in this package file`,
					);
				}
				if (local.bytes !== file.bytes || local.sha256 !== file.sha256) {
					throw new SiteTransferCliError(
						"TRANSFER_FILE_DIGEST_MISMATCH",
						`The site expects different contents for ${file.path}`,
					);
				}
			}
			pending = new Set(missing.map((file) => file.path));
			for (const file of missing) {
				for (const path of scan.indexEntries.get(file.path) ?? []) pending.add(path);
			}
		}
		if (pending.size === 0) return summary;

		const total = pending.size;
		const uploadedIndexes = new Set<string>();
		const pool = new UploadPool(UPLOAD_CONCURRENCY, UPLOAD_BUFFER_BYTES);
		let passUploaded = 0;
		const upload = async (path: string, bytes: Uint8Array) => {
			await withRetry(runtime, `Uploading ${path}`, () =>
				client.transferImportUploadFile(operationId, path, bytes, bytes.byteLength),
			);
			passUploaded++;
			summary.uploaded++;
			summary.bytes += bytes.byteLength;
			progress(
				"Uploading",
				`${passUploaded}/${total} files (${formatBytes(summary.bytes)} this run)`,
			);
		};

		const passPending = pending;
		try {
			await unpackSitePackage(openArchive(archivePath), async (file) => {
				if (!passPending.has(file.path)) return;
				const index = scan.indexOf.get(file.path);
				if (index && passPending.has(index) && !uploadedIndexes.has(index)) return;
				const expected = scan.files.get(file.path);
				if (!expected) return;
				const bytes = await readBody(file.body);
				await assertFileMatches(file.path, bytes, expected);
				if (file.parsed.type === "index") {
					await upload(file.path, bytes);
					uploadedIndexes.add(file.path);
					return;
				}
				await pool.add(bytes.byteLength, () => upload(file.path, bytes));
			});
		} catch (error) {
			await pool.settle();
			throw error;
		}
		await pool.drain();

		if (passUploaded === 0) {
			throw new SiteTransferCliError(
				"TRANSFER_FILE_MISSING",
				"The site still expects files that could not be uploaded from this package",
			);
		}
		pending = null;
	}
}

// ── Analysis ───────────────────────────────────────────────────

export interface PlannedImport {
	operation: TransferOperation;
	plan: SiteImportPlan;
	planDigest: string;
}

/** Advance analysis until the import is planned. */
export async function driveAnalysis(
	client: EmDashClient,
	operation: TransferOperation,
	runtime: TransferRuntime,
): Promise<PlannedImport> {
	const progress = createProgressLogger(runtime);
	for (;;) {
		const step = await withRetry(runtime, "Analysis step", () =>
			client.transferImportAnalyze(operation.id),
		).catch(async (error: unknown) => {
			if (error instanceof EmDashApiError && error.code === "TRANSFER_INVALID_STATE") {
				const { operation: current } = await client.transferImportGet(operation.id);
				if (ENDED_WITHOUT_RECEIPT.has(current.state)) throw operationError(current);
			}
			throw error;
		});
		const current = step.operation;
		if (step.nextRequestInMs === null) {
			if (current.state !== "planned" || !step.plan || !step.planDigest) {
				throw operationError(current);
			}
			return { operation: current, plan: step.plan, planDigest: step.planDigest };
		}
		progress(`Analyzing (${current.stage ?? current.state})`, formatProgress(current.progress));
		await sleepFor(runtime, step.nextRequestInMs);
	}
}

/** Submit decisions for a planned import; returns the resulting plan. */
export async function applyDecisions(
	client: EmDashClient,
	operationId: string,
	decisions: SiteImportDecisionsInput,
	runtime: TransferRuntime,
): Promise<PlannedImport> {
	const decided = await withRetry(runtime, "Applying decisions", () =>
		client.transferImportAnalyze(operationId, decisions),
	);
	if (!decided.plan || !decided.planDigest) throw operationError(decided.operation);
	return { operation: decided.operation, plan: decided.plan, planDigest: decided.planDigest };
}

// ── Decisions from flags ───────────────────────────────────────

export interface DecisionFlags {
	/** Raw `--map-principal` values: `<principal id|email>=<user id|email|none>`. */
	mapPrincipal: string[];
	useTargetTitle: boolean;
	useTargetTagline: boolean;
}

export function hasDecisions(flags: DecisionFlags): boolean {
	return flags.mapPrincipal.length > 0 || flags.useTargetTitle || flags.useTargetTagline;
}

const USER_PAGES = 50;

async function targetUsersByEmail(
	client: EmDashClient,
	runtime: TransferRuntime,
): Promise<Map<string, string[]>> {
	const byEmail = new Map<string, string[]>();
	let cursor: string | undefined;
	for (let page = 0; page < USER_PAGES; page++) {
		const result = await withRetry(runtime, "Listing users", () =>
			client.users({ limit: 100, cursor }),
		);
		for (const user of result.items) {
			const key = user.email.toLowerCase();
			byEmail.set(key, [...(byEmail.get(key) ?? []), user.id]);
		}
		if (!result.nextCursor) break;
		cursor = result.nextCursor;
	}
	return byEmail;
}

/**
 * Turn decision flags into plan decisions. Principals are matched by id, or
 * by email (case-insensitive); target users by id, by email through the
 * users API, or `none` to leave the references unassigned.
 */
export async function resolveDecisions(
	client: EmDashClient,
	plan: SiteImportPlan,
	flags: DecisionFlags,
	runtime: TransferRuntime,
): Promise<SiteImportDecisionsInput> {
	const decisions: SiteImportDecisionsInput = {};
	if (flags.useTargetTitle) decisions.siteTitle = "target";
	if (flags.useTargetTagline) decisions.siteTagline = "target";
	if (flags.mapPrincipal.length === 0) return decisions;

	let users: Map<string, string[]> | undefined;
	const mappings: Record<string, string | null> = {};
	for (const raw of flags.mapPrincipal) {
		const separator = raw.lastIndexOf("=");
		const from = separator > 0 ? raw.slice(0, separator).trim() : "";
		const to = separator > 0 ? raw.slice(separator + 1).trim() : "";
		if (!from || !to) {
			throw new SiteTransferCliError(
				"INVALID_ARGUMENT",
				`--map-principal expects <principal id or email>=<user id, email, or none>, got "${raw}"`,
			);
		}
		const principal =
			plan.principals.find((candidate) => candidate.id === from) ??
			matchOne(
				plan.principals.filter(
					(candidate) => candidate.email?.toLowerCase() === from.toLowerCase(),
				),
				`principal ${from}`,
			);
		if (!principal) {
			throw new SiteTransferCliError(
				"INVALID_ARGUMENT",
				`The package has no principal ${from}. Principals: ${plan.principals.map((p) => p.id).join(", ") || "none"}`,
			);
		}

		let target: string | null;
		if (to.toLowerCase() === "none") {
			target = null;
		} else if (to.includes("@")) {
			users ??= await targetUsersByEmail(client, runtime);
			const ids = users.get(to.toLowerCase()) ?? [];
			if (ids.length !== 1) {
				throw new SiteTransferCliError(
					"INVALID_ARGUMENT",
					ids.length === 0
						? `No user on this site has the email ${to}`
						: `More than one user on this site has the email ${to}; map by user id instead`,
				);
			}
			target = ids[0];
		} else {
			target = to;
		}
		mappings[principal.id] = target;
	}
	decisions.principalMappings = mappings;
	return decisions;
}

function matchOne<T>(matches: T[], label: string): T | undefined {
	if (matches.length > 1) {
		throw new SiteTransferCliError(
			"INVALID_ARGUMENT",
			`More than one ${label} matches; map by principal id instead`,
		);
	}
	return matches[0];
}

// ── Execution ──────────────────────────────────────────────────

export interface CompletedImport {
	operationId: string;
	state: "complete";
	receipt: SiteImportReceipt;
	receiptDigestValid: boolean;
}

/** Advance an executing import until it ends; returns the complete operation. */
export async function driveExecution(
	client: EmDashClient,
	operation: TransferOperation,
	runtime: TransferRuntime,
): Promise<TransferOperation> {
	const progress = createProgressLogger(runtime);
	let current = operation;
	while (isExecuting(current)) {
		const step = await withRetry(runtime, "Import step", () =>
			client.transferImportAdvance(current.id),
		);
		current = step.operation;
		progress(`Importing (${current.stage ?? current.state})`, formatProgress(current.progress));
		if (step.nextRequestInMs === null) break;
		await sleepFor(runtime, step.nextRequestInMs);
	}
	if (current.state !== "complete") throw operationError(current);
	return current;
}

export async function fetchReceipt(
	client: EmDashClient,
	operationId: string,
	runtime: TransferRuntime,
): Promise<CompletedImport> {
	const { receipt } = await withRetry(runtime, "Reading the receipt", () =>
		client.transferImportReceipt(operationId),
	);
	return {
		operationId,
		state: "complete",
		receipt,
		receiptDigestValid: await verifyReceiptDigest(receipt),
	};
}

/**
 * Execute a planned import after checking the reviewed plan digest, then
 * advance it to completion.
 */
export async function executeImport(
	client: EmDashClient,
	operation: TransferOperation,
	planDigest: string,
	runtime: TransferRuntime,
): Promise<CompletedImport> {
	let current = operation;
	if (current.planDigest !== planDigest) {
		throw new SiteTransferCliError(
			"TRANSFER_PLAN_DIGEST_MISMATCH",
			`The plan changed since it was reviewed: the current plan digest is ${current.planDigest ?? "none"}. Run with --analyze again and confirm the new digest.`,
		);
	}
	if (current.state === "planned" && current.stage !== "reserve") {
		if (!current.packageDigest) throw operationError(current);
		const packageDigest = current.packageDigest;
		current = (
			await withRetry(runtime, "Starting the import", () =>
				client.transferImportExecute(current.id, { packageDigest, planDigest }),
			)
		).operation;
		runtime.reporter.info(`Executing import ${current.id}`);
	}
	const complete = await driveExecution(client, current, runtime);
	return fetchReceipt(client, complete.id, runtime);
}

// ── Commands ───────────────────────────────────────────────────

export interface AnalyzeOutcome extends PlannedImport {
	packageDigest: string;
}

/** Scan, upload, and analyze a package, applying any decisions. */
export async function analyzePackage(
	client: EmDashClient,
	archivePath: string,
	flags: DecisionFlags,
	runtime: TransferRuntime,
): Promise<AnalyzeOutcome | CompletedImport | { operation: TransferOperation }> {
	const { scan, opened } = await prepareImport(client, archivePath, runtime);
	return continueToPlan(client, archivePath, scan, opened, flags, runtime);
}

async function prepareImport(
	client: EmDashClient,
	archivePath: string,
	runtime: TransferRuntime,
): Promise<{ scan: ScannedSitePackage; opened: OpenedImport }> {
	runtime.reporter.info(`Verifying ${archivePath}`);
	const scan = await scanSitePackage(archivePath);
	runtime.reporter.info(
		`Package ${scan.packageDigest}: ${scan.files.size + 1} files, ${formatBytes(scan.totalBytes)}`,
	);
	const opened = await openImport(client, scan, runtime);
	return { scan, opened };
}

async function continueToPlan(
	client: EmDashClient,
	archivePath: string | null,
	scan: ScannedSitePackage | null,
	opened: OpenedImport,
	flags: DecisionFlags,
	runtime: TransferRuntime,
): Promise<AnalyzeOutcome | CompletedImport | { operation: TransferOperation }> {
	const operation = opened.operation;
	if (isExecuting(operation)) return { operation };
	switch (operation.state) {
		case "uploading": {
			if (!archivePath || !scan) {
				throw new SiteTransferCliError(
					"PACKAGE_FILE_REQUIRED",
					`Import ${operation.id} is still uploading. Pass the package file to resume it: emdash site import resume ${operation.id} <file>`,
				);
			}
			const uploaded = await uploadPackage(client, archivePath, scan, opened, runtime);
			runtime.reporter.info(`Uploaded ${uploaded.uploaded} files (${formatBytes(uploaded.bytes)})`);
			return planWithDecisions(client, operation, flags, runtime);
		}
		case "analyzing":
		case "planned":
			return planWithDecisions(client, operation, flags, runtime);
		case "complete":
			runtime.reporter.info(`Import ${operation.id} is already complete`);
			return fetchReceipt(client, operation.id, runtime);
		default:
			return { operation };
	}
}

async function planWithDecisions(
	client: EmDashClient,
	operation: TransferOperation,
	flags: DecisionFlags,
	runtime: TransferRuntime,
): Promise<AnalyzeOutcome> {
	let planned = await driveAnalysis(client, operation, runtime);
	if (hasDecisions(flags)) {
		const decisions = await resolveDecisions(client, planned.plan, flags, runtime);
		planned = await applyDecisions(client, planned.operation.id, decisions, runtime);
	}
	return { ...planned, packageDigest: planned.plan.packageDigest };
}

/** Scan, upload, and analyze if needed, then execute the confirmed plan. */
export async function confirmPackage(
	client: EmDashClient,
	archivePath: string,
	planDigest: string,
	runtime: TransferRuntime,
): Promise<CompletedImport> {
	const { scan, opened } = await prepareImport(client, archivePath, runtime);
	return confirmOperation(client, archivePath, scan, opened, planDigest, runtime);
}

async function confirmOperation(
	client: EmDashClient,
	archivePath: string | null,
	scan: ScannedSitePackage | null,
	opened: OpenedImport,
	planDigest: string,
	runtime: TransferRuntime,
): Promise<CompletedImport> {
	const operation = opened.operation;
	if (operation.state === "complete") {
		if (operation.planDigest !== planDigest) {
			throw new SiteTransferCliError(
				"TRANSFER_PLAN_DIGEST_MISMATCH",
				`Import ${operation.id} already completed with a different plan (${operation.planDigest ?? "none"})`,
			);
		}
		return fetchReceipt(client, operation.id, runtime);
	}
	if (isExecuting(operation)) {
		return executeImport(client, operation, planDigest, runtime);
	}
	const outcome = await continueToPlan(
		client,
		archivePath,
		scan,
		opened,
		{ mapPrincipal: [], useTargetTitle: false, useTargetTagline: false },
		runtime,
	);
	if (!("plan" in outcome)) {
		if ("receipt" in outcome) return outcome;
		throw operationError(outcome.operation);
	}
	if (outcome.plan.blockers.length > 0) {
		throw new SiteTransferCliError(
			"TRANSFER_PLAN_BLOCKED",
			`The import plan has ${outcome.plan.blockers.length} blocker(s). Run with --analyze to see them.`,
		);
	}
	return executeImport(client, outcome.operation, planDigest, runtime);
}

export async function importStatus(
	client: EmDashClient,
	operationId: string,
	runtime: TransferRuntime,
): Promise<{ operation: TransferOperation; files: { declared: number; verified: number } }> {
	return withRetry(runtime, "Reading the import", () => client.transferImportGet(operationId));
}

/**
 * Continue an import from whatever state it is in: upload what is missing
 * (needs the package file), finish analysis, or finish execution.
 */
export async function resumeImport(
	client: EmDashClient,
	operationId: string,
	archivePath: string | null,
	runtime: TransferRuntime,
): Promise<AnalyzeOutcome | CompletedImport | { operation: TransferOperation }> {
	const { operation } = await importStatus(client, operationId, runtime);
	if (isExecuting(operation)) {
		const complete = await driveExecution(client, operation, runtime);
		return fetchReceipt(client, complete.id, runtime);
	}
	let scan: ScannedSitePackage | null = null;
	if (operation.state === "uploading" && archivePath) {
		runtime.reporter.info(`Verifying ${archivePath}`);
		scan = await scanSitePackage(archivePath);
		if (scan.packageDigest !== operation.packageDigest) {
			throw new SiteTransferCliError(
				"TRANSFER_PACKAGE_DIGEST_MISMATCH",
				`${archivePath} is not the package import ${operation.id} was created from`,
			);
		}
	}
	return continueToPlan(
		client,
		archivePath,
		scan,
		{ operation, fresh: false },
		{ mapPrincipal: [], useTargetTitle: false, useTargetTagline: false },
		runtime,
	);
}

export async function importReceipt(
	client: EmDashClient,
	operationId: string,
	runtime: TransferRuntime,
): Promise<CompletedImport> {
	return fetchReceipt(client, operationId, runtime);
}

/**
 * Resolve a refused cancel or abandon: a retry of a request whose response
 * was lost finds the import already in `state`.
 */
async function settledAs(
	client: EmDashClient,
	operationId: string,
	error: unknown,
	state: "cancelled" | "abandoned",
	runtime: TransferRuntime,
): Promise<TransferOperation> {
	if (!(error instanceof EmDashApiError) || error.code !== "TRANSFER_INVALID_STATE") throw error;
	const { operation } = await importStatus(client, operationId, runtime);
	if (operation.state === state) return operation;
	throw new SiteTransferCliError(
		"TRANSFER_INVALID_STATE",
		state === "abandoned"
			? `Only a failed or cancelled import can be abandoned; import ${operationId} is ${operation.state}.`
			: `Import ${operationId} has already ended as ${operation.state}.`,
	);
}

/**
 * Cancel an import. An import no request is working on is cancelled at
 * once; one mid-step stops after its current batch.
 */
export async function cancelImport(
	client: EmDashClient,
	operationId: string,
	runtime: TransferRuntime,
): Promise<TransferOperation> {
	return withRetry(runtime, "Cancelling the import", () =>
		client.transferImportCancel(operationId),
	).then(
		(result) => result.operation,
		(error: unknown) => settledAs(client, operationId, error, "cancelled", runtime),
	);
}

/** Abandon a failed or cancelled import: lift its write block, keeping what it wrote. */
export async function abandonImport(
	client: EmDashClient,
	operationId: string,
	runtime: TransferRuntime,
): Promise<TransferOperation> {
	return withRetry(runtime, "Abandoning the import", () =>
		client.transferImportAbandon(operationId),
	).then(
		(result) => result.operation,
		(error: unknown) => settledAs(client, operationId, error, "abandoned", runtime),
	);
}
