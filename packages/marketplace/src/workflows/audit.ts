import { WorkflowEntrypoint } from "cloudflare:workers";
import type { WorkflowEvent, WorkflowStep } from "cloudflare:workers";
import { createGzipDecoder, unpackTar } from "modern-tar";

import type { ImageInput } from "../audit/image-types.js";
import { createWorkersAIImageAuditor } from "../audit/image-workers-ai.js";
import type { AuditInput } from "../audit/types.js";
import { createWorkersAIAuditor } from "../audit/workers-ai.js";
import {
	createAudit,
	createImageAudit,
	linkAuditToVersion,
	linkImageAuditToVersion,
	updateVersionStatus,
} from "../db/queries.js";
import { getAuditEnforcement, resolveVersionStatus } from "../env.js";

// ── Types ───────────────────────────────────────────────────────

export interface AuditParams {
	pluginId: string;
	version: string;
	bundleKey: string;
	versionId: string;
	/** Manifest fields needed for audit input */
	manifest: {
		id: string;
		version: string;
		capabilities: string[];
		allowedHosts?: string[];
		admin?: { settingsSchema?: Record<string, unknown> };
	};
	/** Whether the tarball contains images to audit */
	hasImages: boolean;
}

interface CodeAuditStepResult {
	verdict: string;
	riskScore: number;
	findings: unknown[];
	summary: string;
	model: string;
	durationMs: number;
}

interface ImageAuditStepResult {
	verdict: string;
	images: unknown[];
	model: string;
	durationMs: number;
}

// ── Constants ───────────────────────────────────────────────────

const RE_LEADING_DOT_SLASH = /^\.\//;
const RE_LEADING_PACKAGE = /^package\//;
const MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_TAR_FILES = 200;

const RETRY_CONFIG = {
	retries: {
		limit: 3,
		delay: "10 seconds" as const,
		backoff: "exponential" as const,
	},
};

// ── Workflow ─────────────────────────────────────────────────────

export class AuditWorkflow extends WorkflowEntrypoint<Env, AuditParams> {
	override async run(event: Readonly<WorkflowEvent<AuditParams>>, step: WorkflowStep) {
		const { pluginId, version, bundleKey, versionId, manifest, hasImages } = event.payload;

		// Step 1: Run code audit
		const auditResult = await step.do("code-audit", RETRY_CONFIG, async () => {
			const { backendCode, adminCode } = await this.extractCodeFromR2(bundleKey);
			const auditor = createWorkersAIAuditor(this.env.AI);
			const input: AuditInput = {
				manifest,
				backendCode,
				adminCode,
			};
			const result = await auditor.audit(input);
			// Return a plain serializable object (no class instances)
			return {
				verdict: result.verdict,
				riskScore: result.riskScore,
				findings: result.findings,
				summary: result.summary,
				model: result.model,
				durationMs: result.durationMs,
			} satisfies CodeAuditStepResult;
		});

		// Step 2: Run image audit (skip if no images)
		const imageAuditResult = hasImages
			? await step.do("image-audit", RETRY_CONFIG, async () => {
					const imageFiles = await this.extractImagesFromR2(bundleKey);
					if (imageFiles.length === 0) return null;
					const imageAuditor = createWorkersAIImageAuditor(this.env.AI);
					const result = await imageAuditor.auditImages(imageFiles);
					return {
						verdict: result.verdict,
						images: result.images,
						model: result.model,
						durationMs: result.durationMs,
					} satisfies ImageAuditStepResult;
				})
			: null;

		// Step 3: Store results in D1 and link to version
		await step.do("store-results", async () => {
			// Store code audit
			const auditRow = await createAudit(this.env.DB, {
				pluginId,
				version,
				verdict: auditResult.verdict,
				riskScore: auditResult.riskScore,
				summary: auditResult.summary,
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- findings shape is preserved from AuditResult
				findings: auditResult.findings as unknown[],
				model: auditResult.model,
				durationMs: auditResult.durationMs,
			});
			await linkAuditToVersion(this.env.DB, versionId, auditRow.id, auditResult.verdict);

			// Store image audit if available
			if (imageAuditResult) {
				const imageAuditRow = await createImageAudit(this.env.DB, {
					pluginId,
					version,
					verdict: imageAuditResult.verdict,
					// eslint-disable-next-line typescript/no-unsafe-type-assertion -- images shape is preserved from ImageAuditResult
					findings: imageAuditResult.images as unknown[],
					model: imageAuditResult.model,
					durationMs: imageAuditResult.durationMs,
				});
				await linkImageAuditToVersion(
					this.env.DB,
					versionId,
					imageAuditRow.id,
					imageAuditResult.verdict,
				);
			}
		});

		// Step 4: Resolve version status and update D1
		await step.do("finalize", async () => {
			const enforcement = getAuditEnforcement(this.env);
			const status = resolveVersionStatus(
				enforcement,
				auditResult.verdict,
				imageAuditResult?.verdict ?? null,
			);
			await updateVersionStatus(this.env.DB, versionId, status);
		});

		return { auditResult, imageAuditResult };
	}

	// ── Helpers ────────────────────────────────────────────────

	private async extractCodeFromR2(
		bundleKey: string,
	): Promise<{ backendCode: string; adminCode?: string }> {
		const object = await this.env.R2.get(bundleKey);
		if (!object) throw new Error(`Bundle not found in R2: ${bundleKey}`);

		const files = await extractTarball(await object.arrayBuffer());
		const backendBytes = files.get("backend.js");
		const backendCode = backendBytes ? new TextDecoder().decode(backendBytes) : "";
		const adminBytes = files.get("admin.js");
		const adminCode = adminBytes ? new TextDecoder().decode(adminBytes) : undefined;

		return { backendCode, adminCode };
	}

	private async extractImagesFromR2(bundleKey: string): Promise<ImageInput[]> {
		const object = await this.env.R2.get(bundleKey);
		if (!object) throw new Error(`Bundle not found in R2: ${bundleKey}`);

		const files = await extractTarball(await object.arrayBuffer());
		const imageFiles: ImageInput[] = [];

		const iconData = files.get("icon.png");
		if (iconData) {
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Uint8Array.buffer is ArrayBuffer at runtime
			imageFiles.push({ filename: "icon.png", data: iconData.buffer as ArrayBuffer });
		}
		for (const [path, data] of files) {
			if (path.startsWith("screenshots/")) {
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Uint8Array.buffer is ArrayBuffer at runtime
				imageFiles.push({ filename: path, data: data.buffer as ArrayBuffer });
			}
		}

		return imageFiles;
	}
}

// ── Tarball extraction (shared with author.ts) ──────────────────

async function collectStream(
	stream: ReadableStream<Uint8Array>,
	limit: number,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.length;
			if (total > limit) {
				throw new Error(`Decompressed bundle exceeds ${limit} byte limit`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const result = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.length;
	}
	return result;
}

async function extractTarball(data: ArrayBuffer): Promise<Map<string, Uint8Array>> {
	const decompressed = await collectStream(
		new Response(data).body!.pipeThrough(createGzipDecoder()),
		MAX_DECOMPRESSED_BYTES,
	);

	let fileCount = 0;
	const entries = await unpackTar(decompressed, {
		strip: 0,
		filter: (header) => {
			if (header.type !== "file") return false;
			if (header.size > MAX_FILE_BYTES) {
				throw new Error(`File ${header.name} exceeds ${MAX_FILE_BYTES} byte limit`);
			}
			fileCount++;
			if (fileCount > MAX_TAR_FILES) {
				throw new Error(`Bundle contains too many files (>${MAX_TAR_FILES})`);
			}
			return true;
		},
		map: (header) => ({
			...header,
			name: header.name.replace(RE_LEADING_DOT_SLASH, "").replace(RE_LEADING_PACKAGE, ""),
		}),
	});

	const files = new Map<string, Uint8Array>();
	for (const entry of entries) {
		if (entry.data && entry.header.name) {
			files.set(entry.header.name, entry.data);
		}
	}
	return files;
}
