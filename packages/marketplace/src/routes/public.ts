import { Hono } from "hono";

import {
	getInstallCount,
	getLatestVersion,
	getPluginVersion,
	getPluginVersions,
	getPluginWithAuthor,
	searchPlugins,
} from "../db/queries.js";

export const publicRoutes = new Hono<{ Bindings: Env }>();

// ── GET /auth/discovery — Auth config for CLI ───────────────────

publicRoutes.get("/auth/discovery", (c) => {
	return c.json({
		github: {
			clientId: c.env.GITHUB_CLIENT_ID,
			deviceAuthorizationEndpoint: "https://github.com/login/device/code",
			tokenEndpoint: "https://github.com/login/oauth/access_token",
		},
		marketplace: {
			deviceTokenEndpoint: "/api/v1/auth/github/device",
		},
	});
});

// ── GET /plugins — Search/list plugins ──────────────────────────

publicRoutes.get("/plugins", async (c) => {
	const url = new URL(c.req.url);
	const q = url.searchParams.get("q") ?? undefined;
	const capability = url.searchParams.get("capability") ?? undefined;
	const sortParam = url.searchParams.get("sort");
	const validSorts = new Set(["installs", "updated", "created", "name", "rating"]);
	let sort: "installs" | "updated" | "created" | "name" | "rating" | undefined;
	if (sortParam && validSorts.has(sortParam)) {
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- validated by Set.has check above
		sort = sortParam as "installs" | "updated" | "created" | "name" | "rating";
	}
	const cursor = url.searchParams.get("cursor") ?? undefined;
	const limitStr = url.searchParams.get("limit");
	const limit = limitStr ? parseInt(limitStr, 10) : undefined;

	const baseUrl = url.origin;

	try {
		const result = await searchPlugins(c.env.DB, { q, capability, sort, cursor, limit });

		const items = result.items.map((row) => ({
			id: row.id,
			name: row.name,
			description: row.description,
			author: {
				name: row.author_name,
				verified: row.author_verified === 1,
				avatarUrl: row.author_avatar_url,
			},
			capabilities: safeJsonParse<string[]>(row.capabilities, []),
			keywords: safeJsonParse<string[]>(row.keywords, []),
			installCount: row.install_count,
			hasIcon: row.has_icon === 1,
			iconUrl: `${baseUrl}/api/v1/plugins/${row.id}/icon`,
			latestVersion: row.latest_version
				? {
						version: row.latest_version,
						audit: row.latest_audit_verdict
							? {
									verdict: row.latest_audit_verdict,
									riskScore: row.latest_audit_risk_score ?? 0,
								}
							: undefined,
						imageAudit: row.latest_image_audit_verdict
							? {
									verdict: row.latest_image_audit_verdict,
								}
							: undefined,
					}
				: undefined,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}));

		return c.json({ items, nextCursor: result.nextCursor });
	} catch (err) {
		console.error("Failed to search plugins:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── GET /plugins/:id — Plugin detail ────────────────────────────

publicRoutes.get("/plugins/:id", async (c) => {
	const id = c.req.param("id");
	const baseUrl = new URL(c.req.url).origin;

	try {
		const plugin = await getPluginWithAuthor(c.env.DB, id);
		if (!plugin) return c.json({ error: "Plugin not found" }, 404);

		const latestVersion = await getLatestVersion(c.env.DB, id);
		const installCount = await getInstallCount(c.env.DB, id);

		const capabilities = safeJsonParse<string[]>(plugin.capabilities, []);
		const keywords = safeJsonParse<string[]>(plugin.keywords, []);

		const response: Record<string, unknown> = {
			id: plugin.id,
			name: plugin.name,
			description: plugin.description,
			author: {
				id: plugin.author_id,
				name: plugin.author_name,
				verified: plugin.author_verified === 1,
				avatarUrl: plugin.author_avatar_url,
			},
			capabilities,
			keywords,
			repositoryUrl: plugin.repository_url,
			homepageUrl: plugin.homepage_url,
			license: plugin.license,
			hasIcon: plugin.has_icon === 1,
			iconUrl: `${baseUrl}/api/v1/plugins/${plugin.id}/icon`,
			installCount,
			rating:
				plugin.rating_count >= 3
					? { average: Math.round(plugin.rating_avg * 10) / 10, count: plugin.rating_count }
					: null,
			createdAt: plugin.created_at,
			updatedAt: plugin.updated_at,
		};

		let latestAuditRiskScore: number | null = null;
		if (latestVersion?.audit_id) {
			const auditRow = await c.env.DB.prepare("SELECT risk_score FROM plugin_audits WHERE id = ?")
				.bind(latestVersion.audit_id)
				.first<{ risk_score: number }>();
			latestAuditRiskScore = auditRow?.risk_score ?? null;
		}

		if (latestVersion) {
			const screenshotUrls: string[] = [];
			for (let i = 0; i < latestVersion.screenshot_count; i++) {
				screenshotUrls.push(
					`${baseUrl}/api/v1/plugins/${id}/versions/${latestVersion.version}/screenshots/screenshot-${i}.png`,
				);
			}

			response.latestVersion = {
				version: latestVersion.version,
				minEmDashVersion: latestVersion.min_emdash_version,
				bundleSize: latestVersion.bundle_size,
				checksum: latestVersion.checksum,
				changelog: latestVersion.changelog,
				readme: latestVersion.readme,
				hasIcon: latestVersion.has_icon === 1,
				screenshotCount: latestVersion.screenshot_count,
				screenshotUrls,
				capabilities: safeJsonParse<string[]>(latestVersion.capabilities, []),
				status: latestVersion.status,
				audit: latestVersion.audit_verdict
					? {
							verdict: latestVersion.audit_verdict,
							riskScore: latestAuditRiskScore ?? 0,
						}
					: undefined,
				imageAudit: latestVersion.image_audit_verdict
					? {
							verdict: latestVersion.image_audit_verdict,
						}
					: undefined,
				publishedAt: latestVersion.published_at,
			};
		}

		return c.json(response);
	} catch (err) {
		console.error("Failed to get plugin:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── GET /plugins/:id/versions — Version history ─────────────────

publicRoutes.get("/plugins/:id/versions", async (c) => {
	const pluginId = c.req.param("id");

	try {
		const versions = await getPluginVersions(c.env.DB, pluginId);

		const items = versions.map((v) => ({
			version: v.version,
			minEmDashVersion: v.min_emdash_version,
			bundleSize: v.bundle_size,
			checksum: v.checksum,
			changelog: v.changelog,
			capabilities: safeJsonParse<string[]>(v.capabilities, []),
			status: v.status,
			auditVerdict: v.audit_verdict,
			imageAuditVerdict: v.image_audit_verdict,
			publishedAt: v.published_at,
		}));

		return c.json({ items });
	} catch (err) {
		console.error("Failed to get versions:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── GET /plugins/:id/versions/:version/bundle — Bundle download ─

publicRoutes.get("/plugins/:id/versions/:version/bundle", async (c) => {
	const pluginId = c.req.param("id");
	const version = c.req.param("version");

	try {
		const versionRow = await getPluginVersion(c.env.DB, pluginId, version);
		if (!versionRow) return c.json({ error: "Version not found" }, 404);
		if (versionRow.status !== "published" && versionRow.status !== "flagged") {
			return c.json({ error: "Version not found" }, 404);
		}

		const object = await c.env.R2.get(versionRow.bundle_key);
		if (!object) return c.json({ error: "Bundle not found" }, 404);

		return new Response(object.body, {
			headers: {
				"Content-Type": "application/gzip",
				"Content-Disposition": `attachment; filename="${pluginId}-${version}.tar.gz"`,
				"Content-Length": String(object.size),
			},
		});
	} catch (err) {
		console.error("Failed to download bundle:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── GET /plugins/:id/versions/:version/audit — Audit result ─────

publicRoutes.get("/plugins/:id/versions/:version/audit", async (c) => {
	const pluginId = c.req.param("id");
	const version = c.req.param("version");

	try {
		const versionRow = await getPluginVersion(c.env.DB, pluginId, version);
		if (!versionRow) return c.json({ error: "Version not found" }, 404);
		if (versionRow.status !== "published" && versionRow.status !== "flagged") {
			return c.json({ error: "Version not found" }, 404);
		}

		if (!versionRow.audit_id) {
			return c.json({ error: "No audit result available" }, 404);
		}

		const audit = await c.env.DB.prepare("SELECT * FROM plugin_audits WHERE id = ?")
			.bind(versionRow.audit_id)
			.first();
		if (!audit) return c.json({ error: "Audit result not found" }, 404);

		return c.json(audit);
	} catch (err) {
		console.error("Failed to get audit:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

// ── GET /plugins/:id/versions/:version/image-audit — Image audit ─

publicRoutes.get("/plugins/:id/versions/:version/image-audit", async (c) => {
	const pluginId = c.req.param("id");
	const version = c.req.param("version");

	try {
		const versionRow = await getPluginVersion(c.env.DB, pluginId, version);
		if (!versionRow) return c.json({ error: "Version not found" }, 404);
		if (versionRow.status !== "published" && versionRow.status !== "flagged") {
			return c.json({ error: "Version not found" }, 404);
		}

		if (!versionRow.image_audit_id) {
			return c.json({ error: "No image audit result available" }, 404);
		}

		const audit = await c.env.DB.prepare("SELECT * FROM plugin_image_audits WHERE id = ?")
			.bind(versionRow.image_audit_id)
			.first();
		if (!audit) return c.json({ error: "Image audit result not found" }, 404);

		return c.json(audit);
	} catch (err) {
		console.error("Failed to get image audit:", err);
		return c.json({ error: "Internal server error" }, 500);
	}
});

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
