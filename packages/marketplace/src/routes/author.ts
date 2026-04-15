import type { Context, Next } from "hono";
import { Hono } from "hono";
import { SignJWT, jwtVerify } from "jose";
import { createGzipDecoder, unpackTar } from "modern-tar";
import { z } from "zod";

/** Matches http(s) scheme at start of URL */
const HTTP_SCHEME_RE = /^https?:\/\//i;

/** Validates that a URL string uses http or https scheme. Rejects javascript:/data: URI XSS vectors. */
const httpUrl = z
	.string()
	.url()
	.refine((url) => HTTP_SCHEME_RE.test(url), "URL must use http or https");

import {
	createAuthor,
	createPlugin,
	createVersion,
	findOrCreateSystemAuthor,
	getAuthorByGithubId,
	getLatestVersion,
	getPlugin,
	getPluginVersion,
	setVersionWorkflowId,
	updatePlugin,
	updateVersionForReseed,
} from "../db/queries.js";
import type { AuthorRow } from "../db/types.js";
import type { AuditParams } from "../workflows/audit.js";

// ── Types ───────────────────────────────────────────────────────

type AuthEnv = { Bindings: Env; Variables: { author: AuthorRow; isSeedAuth: boolean } };

export const authorRoutes = new Hono<AuthEnv>();

// ── Auth: shared GitHub → JWT logic ─────────────────────────────

interface GitHubUser {
	id: number;
	login: string;
	name: string | null;
	email: string | null;
	avatar_url: string;
}

function getGitHubOAuthConfig(
	c: Context<AuthEnv>,
): { clientId: string; clientSecret: string } | Response {
	const clientId = typeof c.env.GITHUB_CLIENT_ID === "string" ? c.env.GITHUB_CLIENT_ID.trim() : "";
	const clientSecret =
		typeof c.env.GITHUB_CLIENT_SECRET === "string" ? c.env.GITHUB_CLIENT_SECRET.trim() : "";
	const missing: string[] = [];

	if (!clientId) missing.push("GITHUB_CLIENT_ID");
	if (!clientSecret) missing.push("GITHUB_CLIENT_SECRET");

	if (missing.length > 0) {
		return c.json(
			{
				error: "GitHub OAuth is not configured on this marketplace deployment.",
				detail: `Missing ${missing.join(", ")}.`,
			},
			503,
		);
	}

	return { clientId, clientSecret };
}

/**
 * Given a GitHub access token, fetch the user, find-or-create author,
 * and return a marketplace JWT. Shared by code exchange and device flow.
 */
async function authenticateWithGitHubToken(
	githubAccessToken: string,
	env: Env,
): Promise<{ token: string; author: { id: string; name: string; avatarUrl: string | null } }> {
	const userResponse = await fetch("https://api.github.com/user", {
		headers: {
			Authorization: `Bearer ${githubAccessToken}`,
			"User-Agent": "EmDash-Marketplace",
		},
	});

	if (!userResponse.ok) {
		throw new Error(`Failed to fetch GitHub user: ${userResponse.status}`);
	}

	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- GitHub API response
	const githubUser: GitHubUser = await userResponse.json();
	const githubId = String(githubUser.id);

	let author = await getAuthorByGithubId(env.DB, githubId);
	if (!author) {
		author = await createAuthor(env.DB, {
			githubId,
			name: githubUser.name ?? githubUser.login,
			email: githubUser.email ?? undefined,
			avatarUrl: githubUser.avatar_url,
		});
	}

	const now = Math.floor(Date.now() / 1000);
	const payload = {
		sub: author.id,
		githubId,
		iat: now,
		exp: now + 86400 * 30, // 30 days
	};

	const token = await signJwt(payload, env.GITHUB_CLIENT_SECRET);

	return {
		token,
		author: {
			id: author.id,
			name: author.name,
			avatarUrl: author.avatar_url,
		},
	};
}

// ── Auth: GitHub OAuth code exchange (web flow) ─────────────────

const githubAuthSchema = z.object({
	code: z.string().min(1),
});

authorRoutes.post("/auth/github", async (c) => {
	const config = getGitHubOAuthConfig(c);
	if (config instanceof Response) return config;

	let body: z.infer<typeof githubAuthSchema>;
	try {
		const raw = await c.req.json();
		body = githubAuthSchema.parse(raw);
	} catch (err) {
		if (err instanceof z.ZodError) {
			return c.json({ error: "Invalid request body", details: err.errors }, 400);
		}
		return c.json({ error: "Invalid JSON" }, 400);
	}

	try {
		// Exchange code for GitHub access token
		const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "application/json",
			},
			body: JSON.stringify({
				client_id: config.clientId,
				client_secret: config.clientSecret,
				code: body.code,
			}),
		});

		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- GitHub OAuth response
		const tokenData: {
			access_token?: string;
			error?: string;
			error_description?: string;
		} = await tokenResponse.json();

		if (!tokenData.access_token) {
			return c.json(
				{ error: "GitHub auth failed", detail: tokenData.error_description ?? tokenData.error },
				401,
			);
		}

		const result = await authenticateWithGitHubToken(tokenData.access_token, c.env);
		return c.json(result);
	} catch (err) {
		console.error("GitHub auth error:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── Auth: GitHub device flow (CLI) ──────────────────────────────

const githubDeviceAuthSchema = z.object({
	access_token: z.string().min(1),
});

authorRoutes.post("/auth/github/device", async (c) => {
	const config = getGitHubOAuthConfig(c);
	if (config instanceof Response) return config;

	let body: z.infer<typeof githubDeviceAuthSchema>;
	try {
		const raw = await c.req.json();
		body = githubDeviceAuthSchema.parse(raw);
	} catch (err) {
		if (err instanceof z.ZodError) {
			return c.json({ error: "Invalid request body", details: err.errors }, 400);
		}
		return c.json({ error: "Invalid JSON" }, 400);
	}

	try {
		const result = await authenticateWithGitHubToken(body.access_token, c.env);
		return c.json(result);
	} catch (err) {
		console.error("GitHub device auth error:", err);
		if (err instanceof Error && err.message.includes("Failed to fetch GitHub user")) {
			return c.json({ error: "Invalid GitHub access token" }, 401);
		}
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── Auth middleware for all routes below ─────────────────────────

/**
 * Timing-safe comparison of two strings.
 * Hashes both values to a fixed length before comparing, so neither
 * the length nor the content of the secret leaks via timing.
 */
async function timingSafeEqual(a: string, b: string): Promise<boolean> {
	const encoder = new TextEncoder();
	const [hashA, hashB] = await Promise.all([
		crypto.subtle.digest("SHA-256", encoder.encode(a)),
		crypto.subtle.digest("SHA-256", encoder.encode(b)),
	]);
	return crypto.subtle.timingSafeEqual(hashA, hashB);
}

// eslint-disable-next-line typescript-eslint(no-redundant-type-constituents) -- Hono middleware returns Response | void
async function authMiddleware(c: Context<AuthEnv>, next: Next): Promise<Response | void> {
	const header = c.req.header("Authorization");
	if (!header?.startsWith("Bearer ")) {
		return c.json({ error: "Authorization header required" }, 401);
	}

	const token = header.slice(7);

	// Seed token auth -- trusted publisher for CI seeding.
	// Bypasses GitHub OAuth; resolves to a system author.
	if (c.env.SEED_TOKEN && (await timingSafeEqual(token, c.env.SEED_TOKEN))) {
		const author = await findOrCreateSystemAuthor(c.env.DB);
		c.set("author", author);
		c.set("isSeedAuth", true);
		return next();
	}

	// Standard JWT auth
	try {
		const payload = await verifyJwt(token, c.env.GITHUB_CLIENT_SECRET);
		if (!payload || typeof payload.sub !== "string") {
			return c.json({ error: "Invalid token" }, 401);
		}

		// Verify author still exists
		const author = await c.env.DB.prepare("SELECT * FROM authors WHERE id = ?")
			.bind(payload.sub)
			.first<AuthorRow>();

		if (!author) {
			return c.json({ error: "Author not found" }, 401);
		}

		c.set("author", author);
		c.set("isSeedAuth", false);
		return next();
	} catch {
		return c.json({ error: "Invalid or expired token" }, 401);
	}
}

// Apply auth middleware to author-only methods (POST/PUT) on /plugins/*
// Using method-specific middleware avoids blocking public GET routes (icons, etc.)
// that share the /plugins/* path when mounted on the same prefix.
authorRoutes.post("/plugins/*", authMiddleware);
authorRoutes.put("/plugins/*", authMiddleware);

// ── POST /plugins — Register new plugin ─────────────────────────

// Must stay in sync with PluginCapability in emdash core
/** Must stay in sync with PLUGIN_CAPABILITIES in packages/core/src/plugins/manifest-schema.ts */
const VALID_CAPABILITIES = [
	"network:fetch",
	"network:fetch:any",
	"read:content",
	"write:content",
	"read:media",
	"write:media",
	"read:users",
	"email:send",
	"email:provide",
	"email:intercept",
] as const;

const createPluginSchema = z.object({
	id: z
		.string()
		.min(1)
		.max(64)
		.regex(
			/^[a-z][a-z0-9-]*$/,
			"ID must start with a letter and contain only lowercase letters, numbers, and hyphens",
		),
	name: z.string().min(1).max(100),
	description: z.string().max(200).optional(),
	repositoryUrl: httpUrl.optional(),
	homepageUrl: httpUrl.optional(),
	license: z.string().max(64).optional(),
	capabilities: z.array(z.enum(VALID_CAPABILITIES)).min(1),
	keywords: z.array(z.string().max(50)).max(20).optional(),
});

authorRoutes.post("/plugins", async (c) => {
	const author = c.get("author");

	let body: z.infer<typeof createPluginSchema>;
	try {
		const raw = await c.req.json();
		body = createPluginSchema.parse(raw);
	} catch (err) {
		if (err instanceof z.ZodError) {
			return c.json({ error: "Validation error", details: err.errors }, 400);
		}
		return c.json({ error: "Invalid JSON" }, 400);
	}

	try {
		// Check if plugin ID already exists
		const existing = await getPlugin(c.env.DB, body.id);
		if (existing) {
			return c.json({ error: "Plugin ID already exists" }, 409);
		}

		const plugin = await createPlugin(c.env.DB, {
			id: body.id,
			name: body.name,
			description: body.description,
			authorId: author.id,
			repositoryUrl: body.repositoryUrl,
			homepageUrl: body.homepageUrl,
			license: body.license,
			capabilities: body.capabilities,
			keywords: body.keywords,
		});

		return c.json(plugin, 201);
	} catch (err) {
		console.error("Failed to create plugin:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── POST /plugins/:id/versions — Publish version ────────────────

authorRoutes.post("/plugins/:id/versions", async (c) => {
	const author = c.get("author");
	const isSeed = c.get("isSeedAuth") === true;
	const pluginId = c.req.param("id");

	try {
		// Verify plugin exists and author owns it.
		// Seed auth: auto-register the plugin if it doesn't exist, skip ownership check.
		let plugin = await getPlugin(c.env.DB, pluginId);
		if (!plugin && isSeed) {
			// Auto-register for seed -- we'll update capabilities after manifest parse
			plugin = await createPlugin(c.env.DB, {
				id: pluginId,
				name: pluginId,
				authorId: author.id,
				capabilities: [],
			});
		} else if (!plugin) {
			return c.json({ error: "Plugin not found" }, 404);
		} else if (plugin.author_id !== author.id) {
			// Ownership check applies to both seed and normal auth.
			// Seed can only publish to plugins it created (system author).
			return c.json({ error: "Not authorized to publish to this plugin" }, 403);
		}

		// Parse multipart form
		const formData = await c.req.formData();
		const bundleFile = formData.get("bundle");
		if (!bundleFile || !(bundleFile instanceof File)) {
			return c.json({ error: "Bundle file is required" }, 400);
		}

		const bundleData = await bundleFile.arrayBuffer();
		if (bundleData.byteLength === 0) {
			return c.json({ error: "Bundle file is empty" }, 400);
		}
		if (bundleData.byteLength > MAX_BUNDLE_BYTES) {
			return c.json({ error: `Bundle exceeds ${MAX_BUNDLE_BYTES} byte limit` }, 413);
		}

		// Extract tarball contents
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

		// Read manifest
		const manifestData = files.get("manifest.json");
		if (!manifestData) {
			return c.json({ error: "Bundle must contain manifest.json" }, 400);
		}

		let manifest: Record<string, unknown>;
		try {
			manifest = JSON.parse(new TextDecoder().decode(manifestData));
		} catch {
			return c.json({ error: "Invalid manifest.json" }, 400);
		}

		// Validate manifest
		const manifestResult = manifestSchema.safeParse(manifest);
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
		const validManifest = manifestResult.data;
		if (validManifest.id !== pluginId) {
			return c.json(
				{
					error: "Manifest ID must match plugin ID",
					expected: pluginId,
					received: validManifest.id,
				},
				400,
			);
		}

		// Validate semver > latest published version (skip for seed -- seed is idempotent)
		if (!isSeed) {
			const latestVersion = await getLatestVersion(c.env.DB, pluginId);
			if (latestVersion) {
				if (!isNewerVersion(latestVersion.version, validManifest.version)) {
					return c.json(
						{
							error: "Version must be greater than latest published version",
							latestVersion: latestVersion.version,
						},
						409,
					);
				}
			}
		}

		// Check for duplicate version.
		// Seed: allow re-publishing the same version (idempotent upsert).
		// Normal: reject duplicate versions.
		const existingVersion = await getPluginVersion(c.env.DB, pluginId, validManifest.version);
		if (existingVersion && !isSeed) {
			return c.json({ error: "Version already exists" }, 409);
		}

		// Detect capability escalation
		const currentCaps = safeJsonParse<string[]>(plugin.capabilities, []);
		const newCaps = validManifest.capabilities;
		const escalated = newCaps.filter((cap) => !currentCaps.includes(cap));
		if (escalated.length > 0) {
			console.warn(`Capability escalation for ${pluginId}: ${escalated.join(", ")}`);
		}

		// Compute SHA-256 checksum
		const hashBuffer = await crypto.subtle.digest("SHA-256", bundleData);
		const checksum = Array.from(new Uint8Array(hashBuffer), (b) =>
			b.toString(16).padStart(2, "0"),
		).join("");

		// Store tarball in R2
		const bundleKey = `${pluginId}/${validManifest.version}.tar.gz`;
		await c.env.R2.put(bundleKey, bundleData, {
			httpMetadata: { contentType: "application/gzip" },
		});

		// Store extracted icon in R2
		const iconData = files.get("icon.png");
		const hasIcon = !!iconData;
		if (iconData) {
			await c.env.R2.put(`plugin-bundles/${pluginId}/${validManifest.version}/icon.png`, iconData, {
				httpMetadata: { contentType: "image/png" },
			});
		}

		// Store screenshots in R2
		const screenshotEntries = [...files.entries()].filter(([path]) =>
			path.startsWith("screenshots/"),
		);
		for (const [path, data] of screenshotEntries) {
			await c.env.R2.put(`plugin-bundles/${pluginId}/${validManifest.version}/${path}`, data, {
				httpMetadata: { contentType: guessContentType(path) },
			});
		}

		// Read optional files
		const readmeBytes = files.get("README.md");
		const readme = readmeBytes ? new TextDecoder().decode(readmeBytes) : undefined;
		const changelog = validManifest.changelog;

		// Create or update version row
		let versionRow;
		if (existingVersion && isSeed) {
			// Re-seed: update existing version with new bundle data
			await updateVersionForReseed(c.env.DB, existingVersion.id, {
				bundleKey,
				bundleSize: bundleData.byteLength,
				checksum,
				changelog,
				readme,
				hasIcon,
				screenshotCount: screenshotEntries.length,
				capabilities: validManifest.capabilities,
			});
			versionRow = (await getPluginVersion(c.env.DB, pluginId, validManifest.version))!;
		} else {
			versionRow = await createVersion(c.env.DB, {
				pluginId,
				version: validManifest.version,
				minEmDashVersion: validManifest.minEmDashVersion,
				bundleKey,
				bundleSize: bundleData.byteLength,
				checksum,
				changelog,
				readme,
				hasIcon,
				screenshotCount: screenshotEntries.length,
				capabilities: validManifest.capabilities,
				// Seed: publish immediately. Normal: pending audit.
				status: isSeed ? "published" : "pending",
			});
		}

		// Update plugin metadata with latest version info
		await updatePlugin(c.env.DB, pluginId, {
			capabilities: validManifest.capabilities,
			hasIcon,
		});

		// Seed: skip audit, return 201 (published immediately).
		// Normal: dispatch audit Workflow, return 202 (pending).
		if (isSeed) {
			return c.json(
				{
					version: versionRow.version,
					bundleSize: versionRow.bundle_size,
					checksum: versionRow.checksum,
					publishedAt: versionRow.published_at,
					status: "published",
				},
				201,
			);
		}

		// Check if tarball contains images (for Workflow to know whether to run image audit)
		const hasImages = hasIcon || [...files.keys()].some((path) => path.startsWith("screenshots/"));

		// Dispatch audit Workflow asynchronously
		const workflowParams: AuditParams = {
			pluginId,
			version: validManifest.version,
			bundleKey,
			versionId: versionRow.id,
			manifest: {
				id: validManifest.id,
				version: validManifest.version,
				capabilities: validManifest.capabilities,
				allowedHosts: validManifest.allowedHosts,
				admin: validManifest.admin,
			},
			hasImages,
		};

		const instance = await c.env.AUDIT_WORKFLOW.create({
			id: versionRow.id,
			params: workflowParams,
		});

		// Store Workflow instance ID on version row
		await setVersionWorkflowId(c.env.DB, versionRow.id, instance.id);

		return c.json(
			{
				version: versionRow.version,
				bundleSize: versionRow.bundle_size,
				checksum: versionRow.checksum,
				publishedAt: versionRow.published_at,
				status: "pending",
				workflowId: instance.id,
			},
			202,
		);
	} catch (err) {
		console.error("Failed to publish version:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── PUT /plugins/:id — Update plugin metadata ───────────────────

const updatePluginSchema = z.object({
	name: z.string().min(1).max(100).optional(),
	description: z.string().max(200).optional(),
	repositoryUrl: httpUrl.optional(),
	homepageUrl: httpUrl.optional(),
	license: z.string().max(64).optional(),
	keywords: z.array(z.string().max(50)).max(20).optional(),
});

authorRoutes.put("/plugins/:id", async (c) => {
	const author = c.get("author");
	const pluginId = c.req.param("id");

	let body: z.infer<typeof updatePluginSchema>;
	try {
		const raw = await c.req.json();
		body = updatePluginSchema.parse(raw);
	} catch (err) {
		if (err instanceof z.ZodError) {
			return c.json({ error: "Validation error", details: err.errors }, 400);
		}
		return c.json({ error: "Invalid JSON" }, 400);
	}

	try {
		const plugin = await getPlugin(c.env.DB, pluginId);
		if (!plugin) return c.json({ error: "Plugin not found" }, 404);
		if (plugin.author_id !== author.id) {
			return c.json({ error: "Not authorized to update this plugin" }, 403);
		}

		const updated = await updatePlugin(c.env.DB, pluginId, {
			name: body.name,
			description: body.description,
			repositoryUrl: body.repositoryUrl,
			homepageUrl: body.homepageUrl,
			license: body.license,
			keywords: body.keywords,
		});

		return c.json(updated);
	} catch (err) {
		console.error("Failed to update plugin:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── POST /plugins/:id/versions/:version/retry-audit — Re-run audit ──

authorRoutes.post("/plugins/:id/versions/:version/retry-audit", async (c) => {
	const author = c.get("author");
	const pluginId = c.req.param("id");
	const version = c.req.param("version");

	try {
		const plugin = await getPlugin(c.env.DB, pluginId);
		if (!plugin) return c.json({ error: "Plugin not found" }, 404);
		if (plugin.author_id !== author.id) {
			return c.json({ error: "Not authorized" }, 403);
		}

		const versionRow = await getPluginVersion(c.env.DB, pluginId, version);
		if (!versionRow) return c.json({ error: "Version not found" }, 404);

		// Only allow retry for pending or rejected versions
		if (versionRow.status !== "pending" && versionRow.status !== "rejected") {
			return c.json(
				{ error: `Cannot retry audit for version with status "${versionRow.status}"` },
				409,
			);
		}

		// Check if tarball has images
		const hasImages = versionRow.has_icon === 1 || versionRow.screenshot_count > 0;

		// Parse capabilities from JSON
		const capabilities = safeJsonParse<string[]>(versionRow.capabilities, []);

		const workflowParams: AuditParams = {
			pluginId,
			version: versionRow.version,
			bundleKey: versionRow.bundle_key,
			versionId: versionRow.id,
			manifest: {
				id: pluginId,
				version: versionRow.version,
				capabilities,
			},
			hasImages,
		};

		const instance = await c.env.AUDIT_WORKFLOW.create({
			id: versionRow.id,
			params: workflowParams,
		});

		await setVersionWorkflowId(c.env.DB, versionRow.id, instance.id);

		return c.json({
			status: "pending",
			workflowId: instance.id,
			message: "Audit workflow restarted",
		});
	} catch (err) {
		console.error("Failed to retry audit:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── Regex constants (hoisted for lint) ──────────────────────────

const RE_SEMVER_FULL = /^(\d+)\.(\d+)\.(\d+)$/;
const RE_LEADING_DOT_SLASH = /^\.\//;
const RE_LEADING_PACKAGE = /^package\//;

const MAX_BUNDLE_BYTES = 10 * 1024 * 1024;
const MAX_DECOMPRESSED_BYTES = 50 * 1024 * 1024;
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

// ── JWT helpers (HMAC-SHA256) ────────────────────────────────────

async function signJwt(payload: Record<string, unknown>, secret: string): Promise<string> {
	const key = new TextEncoder().encode(secret);
	return new SignJWT(payload)
		.setProtectedHeader({ alg: "HS256" })
		.setIssuedAt()
		.setExpirationTime(typeof payload.exp === "number" ? payload.exp : "30d")
		.sign(key);
}

async function verifyJwt(token: string, secret: string): Promise<Record<string, unknown> | null> {
	try {
		const key = new TextEncoder().encode(secret);
		const { payload } = await jwtVerify(token, key, { algorithms: ["HS256"] });
		return payload as Record<string, unknown>;
	} catch {
		return null;
	}
}

// ── Manifest validation ─────────────────────────────────────────

/** Must stay in sync with HOOK_NAMES in packages/core/src/plugins/manifest-schema.ts */
const VALID_HOOKS = [
	"plugin:install",
	"plugin:activate",
	"plugin:deactivate",
	"plugin:uninstall",
	"content:beforeSave",
	"content:afterSave",
	"content:beforeDelete",
	"content:afterDelete",
	"media:beforeUpload",
	"media:afterUpload",
	"cron",
	"email:beforeSend",
	"email:deliver",
	"email:afterSend",
	"email:status",
	"comment:beforeCreate",
	"comment:moderate",
	"comment:afterCreate",
	"comment:afterModerate",
	"page:metadata",
	"page:fragments",
] as const;

const storageCollectionSchema = z.object({
	indexes: z.array(z.union([z.string(), z.array(z.string())])),
	uniqueIndexes: z.array(z.union([z.string(), z.array(z.string())])).optional(),
});

/** Hook entry: plain string or structured object with metadata */
const hookEntrySchema = z.union([
	z.enum(VALID_HOOKS),
	z.object({
		name: z.enum(VALID_HOOKS),
		exclusive: z.boolean().optional(),
		priority: z.number().int().optional(),
		timeout: z.number().int().positive().optional(),
	}),
]);

/** Route entry: plain string or structured object with metadata */
const routeNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_\-/]*$/;
const routeEntrySchema = z.union([
	z.string().min(1).regex(routeNamePattern, "Route name must be a safe path segment"),
	z.object({
		name: z.string().min(1).regex(routeNamePattern, "Route name must be a safe path segment"),
		public: z.boolean().optional(),
	}),
]);

export const manifestSchema = z.object({
	// Core PluginManifest fields
	id: z.string().min(1),
	version: z.string().regex(RE_SEMVER_FULL, "Must be valid semver"),
	capabilities: z.array(z.enum(VALID_CAPABILITIES)),
	allowedHosts: z.array(z.string()).default([]),
	storage: z.record(z.string(), storageCollectionSchema).default({}),
	hooks: z.array(hookEntrySchema).default([]),
	routes: z.array(routeEntrySchema).default([]),
	admin: z
		.object({
			entry: z.string().optional(),
			settingsSchema: z.record(z.string(), z.unknown()).optional(),
			pages: z
				.array(z.object({ path: z.string(), label: z.string(), icon: z.string().optional() }))
				.optional(),
			widgets: z
				.array(
					z.object({
						id: z.string(),
						size: z.enum(["full", "half", "third"]).optional(),
						title: z.string().optional(),
					}),
				)
				.optional(),
		})
		.default({}),
	// Marketplace publishing extras (not part of core PluginManifest)
	name: z.string().min(1).max(100).optional(),
	description: z.string().max(200).optional(),
	minEmDashVersion: z.string().optional(),
	changelog: z.string().optional(),
});

// ── Semver comparison (simplified) ──────────────────────────────

function parseSemver(v: string): [number, number, number] | null {
	const match = v.match(RE_SEMVER_FULL);
	if (!match) return null;
	return [parseInt(match[1]!, 10), parseInt(match[2]!, 10), parseInt(match[3]!, 10)];
}

function isNewerVersion(current: string, next: string): boolean {
	const c = parseSemver(current);
	const n = parseSemver(next);
	if (!c || !n) return false;

	if (n[0] !== c[0]) return n[0] > c[0];
	if (n[1] !== c[1]) return n[1] > c[1];
	return n[2] > c[2];
}

// ── Tarball extraction ──────────────────────────────────────────

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
			// Strip leading "./" or "package/" prefix common in npm tarballs
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

// ── Helpers ─────────────────────────────────────────────────────

function safeJsonParse<T>(value: string | null, fallback: T): T {
	if (!value) return fallback;
	try {
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- caller provides type parameter
		const parsed: T = JSON.parse(value);
		return parsed;
	} catch {
		return fallback;
	}
}

function guessContentType(filename: string): string {
	if (filename.endsWith(".png")) return "image/png";
	if (filename.endsWith(".jpg") || filename.endsWith(".jpeg")) return "image/jpeg";
	if (filename.endsWith(".webp")) return "image/webp";
	if (filename.endsWith(".gif")) return "image/gif";
	if (filename.endsWith(".svg")) return "image/svg+xml";
	return "application/octet-stream";
}
