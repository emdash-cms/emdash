/**
 * Dev-only routes for testing audit/moderation locally.
 *
 * Gated by hostname — only responds on localhost/127.0.0.1.
 */

import { Hono } from "hono";
import { createGzipDecoder, unpackTar } from "modern-tar";

import type { ImageInput } from "../audit/image-types.js";
import { createWorkersAIImageAuditor } from "../audit/image-workers-ai.js";
import type { AuditInput } from "../audit/types.js";
import { createWorkersAIAuditor } from "../audit/workers-ai.js";
import { getAuditEnforcement } from "../env.js";
import { manifestSchema } from "./author.js";

const RE_LEADING_DOT_SLASH = /^\.\//;
const RE_LEADING_PACKAGE = /^package\//;

type DevEnv = { Bindings: Env };

export const devRoutes = new Hono<DevEnv>();

// Block all requests not from localhost
devRoutes.use("/dev/*", async (c, next) => {
	const url = new URL(c.req.url);
	if (url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
		return c.json({ error: "Dev routes are only available on localhost" }, 403);
	}
	await next();
});

/**
 * POST /dev/audit
 *
 * Accepts either:
 * - A .tar.gz bundle as multipart form data (field: "bundle")
 * - Raw JSON with { backendCode, adminCode?, manifest }
 *
 * Returns code audit + image audit results without auth or DB writes.
 */
devRoutes.post("/dev/audit", async (c) => {
	const contentType = c.req.header("content-type") ?? "";

	let auditInput: AuditInput;
	let imageFiles: ImageInput[] = [];

	if (contentType.includes("multipart/form-data")) {
		// Tarball mode
		const formData = await c.req.formData();
		const bundleFile = formData.get("bundle");
		if (!bundleFile || !(bundleFile instanceof File)) {
			return c.json({ error: "Multipart requests must include a 'bundle' file field" }, 400);
		}

		const bundleData = await bundleFile.arrayBuffer();
		if (bundleData.byteLength === 0) {
			return c.json({ error: "Bundle file is empty" }, 400);
		}

		let files: Map<string, Uint8Array>;
		try {
			files = await extractTarball(bundleData);
		} catch (err) {
			return c.json(
				{
					error: "Failed to extract bundle",
					detail: err instanceof Error ? err.message : "Invalid tarball",
				},
				400,
			);
		}

		const decoder = new TextDecoder();

		const manifestData = files.get("manifest.json");
		if (!manifestData) {
			return c.json({ error: "Bundle must contain manifest.json" }, 400);
		}

		let rawManifest: unknown;
		try {
			rawManifest = JSON.parse(decoder.decode(manifestData));
		} catch {
			return c.json({ error: "Invalid manifest.json" }, 400);
		}

		const manifestResult = manifestSchema.safeParse(rawManifest);
		if (!manifestResult.success) {
			const issues = manifestResult.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
			return c.json(
				{
					error: `Invalid manifest: ${issues.join("; ")}`,
					details: manifestResult.error.errors,
				},
				400,
			);
		}
		const manifest = manifestResult.data;

		const backendBytes = files.get("backend.js");
		const adminBytes = files.get("admin.js");

		auditInput = {
			manifest: {
				id: manifest.id,
				version: manifest.version,
				capabilities: manifest.capabilities,
				allowedHosts: manifest.allowedHosts,
				admin: manifest.admin,
			},
			backendCode: backendBytes ? decoder.decode(backendBytes) : "",
			adminCode: adminBytes ? decoder.decode(adminBytes) : undefined,
		};

		// Collect images
		const iconData = files.get("icon.png");
		if (iconData) {
			imageFiles.push({
				filename: "icon.png",
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Uint8Array.buffer is ArrayBuffer at runtime
				data: iconData.buffer as ArrayBuffer,
			});
		}
		for (const [path, data] of files) {
			if (path.startsWith("screenshots/")) {
				imageFiles.push({
					filename: path,
					// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Uint8Array.buffer is ArrayBuffer at runtime
					data: data.buffer as ArrayBuffer,
				});
			}
		}
	} else {
		// JSON mode — manifest is optional for quick code-only testing
		let body: {
			backendCode: string;
			adminCode?: string;
			manifest?: unknown;
		};
		try {
			body = await c.req.json();
		} catch {
			return c.json({ error: "Invalid JSON body" }, 400);
		}

		if (!body.backendCode) {
			return c.json({ error: "backendCode is required" }, 400);
		}

		if (body.manifest) {
			const manifestResult = manifestSchema.safeParse(body.manifest);
			if (!manifestResult.success) {
				const issues = manifestResult.error.errors.map((e) => `${e.path.join(".")}: ${e.message}`);
				return c.json(
					{
						error: `Invalid manifest: ${issues.join("; ")}`,
						details: manifestResult.error.errors,
					},
					400,
				);
			}
			const m = manifestResult.data;
			auditInput = {
				manifest: {
					id: m.id,
					version: m.version,
					capabilities: m.capabilities,
					allowedHosts: m.allowedHosts,
					admin: m.admin,
				},
				backendCode: body.backendCode,
				adminCode: body.adminCode,
			};
		} else {
			// No manifest provided — use minimal defaults for code-only audit
			auditInput = {
				manifest: {
					id: "dev-test",
					version: "0.0.0",
					capabilities: [],
					allowedHosts: [],
				},
				backendCode: body.backendCode,
				adminCode: body.adminCode,
			};
		}
	}

	// Run audits
	if (!c.env.AI) {
		return c.json({ error: "AI binding not configured �� auditing is unavailable" }, 503);
	}
	const auditor = createWorkersAIAuditor(c.env.AI);
	const imageAuditor = imageFiles.length > 0 ? createWorkersAIImageAuditor(c.env.AI) : null;

	const [codeResult, imageResult] = await Promise.all([
		auditor.audit(auditInput),
		imageAuditor ? imageAuditor.auditImages(imageFiles) : Promise.resolve(null),
	]);

	return c.json({
		enforcement: getAuditEnforcement(c.env),
		code: codeResult,
		images: imageResult,
	});
});

// ── Tarball extraction (duplicated from author.ts to avoid coupling) ──

const MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024; // 50MB decompressed size limit for tarballs
const MAX_TAR_FILES = 200;
const MAX_FILE_BYTES = 5 * 1024 * 1024;

/** Read an entire ReadableStream into a single Uint8Array, aborting if it exceeds `limit` bytes. */
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
	// Decompress fully into memory first, then parse the tar.
	// Passing a pipeThrough() stream directly to unpackTar causes a backpressure
	// deadlock in workerd: the tar decoder's body-stream pull() needs more
	// decompressed data, but the upstream pipe is stalled waiting for the
	// decoder's writable side to drain — a circular dependency.
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
