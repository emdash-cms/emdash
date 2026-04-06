import type {
	AuthorRow,
	PluginAuditRow,
	PluginImageAuditRow,
	PluginRow,
	PluginSearchResult,
	PluginVersionRow,
	PluginWithAuthor,
	SearchOptions,
	ThemeRow,
	ThemeSearchOptions,
	ThemeWithAuthor,
	VersionStatus,
} from "./types.js";

const RE_DASHES = /-/g;

function generateId(): string {
	return crypto.randomUUID().replace(RE_DASHES, "");
}

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

function clampLimit(limit?: number): number {
	if (!limit || limit < 1) return DEFAULT_LIMIT;
	return Math.min(limit, MAX_LIMIT);
}

function encodeCursor(offset: number): string {
	return btoa(String(offset));
}

function decodeCursor(cursor?: string): number {
	if (!cursor) return 0;
	try {
		const decoded = atob(cursor);
		const offset = parseInt(decoded, 10);
		return Number.isNaN(offset) || offset < 0 ? 0 : offset;
	} catch {
		return 0;
	}
}

// ── Plugin queries ──────────────────────────────────────────────

export async function getPlugin(db: D1Database, id: string): Promise<PluginRow | null> {
	return db.prepare("SELECT * FROM plugins WHERE id = ?").bind(id).first<PluginRow>();
}

export async function getPluginWithAuthor(
	db: D1Database,
	id: string,
): Promise<PluginWithAuthor | null> {
	return db
		.prepare(
			`SELECT p.*, a.name AS author_name, a.avatar_url AS author_avatar_url, a.verified AS author_verified
			FROM plugins p
			JOIN authors a ON a.id = p.author_id
			WHERE p.id = ?`,
		)
		.bind(id)
		.first<PluginWithAuthor>();
}

export async function searchPlugins(
	db: D1Database,
	opts: SearchOptions,
): Promise<{ items: PluginSearchResult[]; nextCursor?: string }> {
	const limit = clampLimit(opts.limit);
	const offset = decodeCursor(opts.cursor);

	const conditions: string[] = [];
	const bindings: unknown[] = [];

	if (opts.q) {
		conditions.push("(p.name LIKE ? OR p.description LIKE ? OR p.keywords LIKE ?)");
		const pattern = `%${opts.q}%`;
		bindings.push(pattern, pattern, pattern);
	}

	if (opts.capability) {
		conditions.push("EXISTS (SELECT 1 FROM json_each(p.capabilities) WHERE json_each.value = ?)");
		bindings.push(opts.capability);
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

	let orderBy: string;
	switch (opts.sort) {
		case "name":
			orderBy = "p.name ASC";
			break;
		case "created":
			orderBy = "p.created_at DESC";
			break;
		case "updated":
			orderBy = "p.updated_at DESC";
			break;
		case "installs":
		default:
			orderBy = "install_count DESC, p.created_at DESC";
			break;
	}

	const query = `
		SELECT p.*, a.name AS author_name, a.avatar_url AS author_avatar_url, a.verified AS author_verified,
			p.install_count,
			lv.version AS latest_version,
			lv.status AS latest_status,
			lv.audit_verdict AS latest_audit_verdict,
			lv.image_audit_verdict AS latest_image_audit_verdict,
			pa.risk_score AS latest_audit_risk_score
		FROM plugins p
		JOIN authors a ON a.id = p.author_id
		JOIN (
			SELECT pv.*
			FROM plugin_versions pv
			JOIN (
				SELECT plugin_id, MAX(published_at) AS published_at
				FROM plugin_versions
				WHERE status IN ('published', 'flagged')
				GROUP BY plugin_id
			) latest ON latest.plugin_id = pv.plugin_id AND latest.published_at = pv.published_at
			WHERE pv.status IN ('published', 'flagged')
		) lv ON lv.plugin_id = p.id
		LEFT JOIN plugin_audits pa ON pa.id = lv.audit_id
		${where}
		ORDER BY ${orderBy}
		LIMIT ? OFFSET ?`;

	bindings.push(limit + 1, offset);

	const result = await db
		.prepare(query)
		.bind(...bindings)
		.all<PluginSearchResult>();

	const items = result.results ?? [];
	let nextCursor: string | undefined;

	if (items.length > limit) {
		items.pop();
		nextCursor = encodeCursor(offset + limit);
	}

	return { items, nextCursor };
}

// ── Version queries ─────────────────────────────────────────────

/** Public-facing: only returns published/flagged versions. */
export async function getPluginVersions(
	db: D1Database,
	pluginId: string,
): Promise<PluginVersionRow[]> {
	const result = await db
		.prepare(
			"SELECT * FROM plugin_versions WHERE plugin_id = ? AND status IN ('published', 'flagged') ORDER BY published_at DESC",
		)
		.bind(pluginId)
		.all<PluginVersionRow>();
	return result.results ?? [];
}

/** Returns all versions regardless of status (for author dashboard). */
export async function getAllPluginVersions(
	db: D1Database,
	pluginId: string,
): Promise<PluginVersionRow[]> {
	const result = await db
		.prepare("SELECT * FROM plugin_versions WHERE plugin_id = ? ORDER BY published_at DESC")
		.bind(pluginId)
		.all<PluginVersionRow>();
	return result.results ?? [];
}

/** Public-facing: only returns the latest published/flagged version. */
export async function getLatestVersion(
	db: D1Database,
	pluginId: string,
): Promise<PluginVersionRow | null> {
	return db
		.prepare(
			"SELECT * FROM plugin_versions WHERE plugin_id = ? AND status IN ('published', 'flagged') ORDER BY published_at DESC LIMIT 1",
		)
		.bind(pluginId)
		.first<PluginVersionRow>();
}

export async function getPluginVersion(
	db: D1Database,
	pluginId: string,
	version: string,
): Promise<PluginVersionRow | null> {
	return db
		.prepare("SELECT * FROM plugin_versions WHERE plugin_id = ? AND version = ?")
		.bind(pluginId, version)
		.first<PluginVersionRow>();
}

// ── Install queries ─────────────────────────────────────────────

export async function upsertInstall(
	db: D1Database,
	data: { pluginId: string; siteHash: string; version: string },
): Promise<void> {
	// Insert or update the install row
	const upsertResult = await db
		.prepare(
			`INSERT INTO installs (plugin_id, site_hash, version) VALUES (?, ?, ?)
			ON CONFLICT (plugin_id, site_hash) DO UPDATE SET version = excluded.version, installed_at = datetime('now')`,
		)
		.bind(data.pluginId, data.siteHash, data.version)
		.run();

	// Only increment install_count when a new row was inserted (not an upsert update).
	// D1 reports changes=1 for both INSERT and ON CONFLICT UPDATE, so we use
	// a subquery to get the actual count for correctness.
	if (upsertResult.meta.changes > 0) {
		await db
			.prepare(
				`UPDATE plugins SET install_count = (SELECT COUNT(*) FROM installs WHERE plugin_id = ?) WHERE id = ?`,
			)
			.bind(data.pluginId, data.pluginId)
			.run();
	}
}

// ── Write queries ───────────────────────────────────────────────

export async function createPlugin(
	db: D1Database,
	data: {
		id: string;
		name: string;
		description?: string;
		authorId: string;
		repositoryUrl?: string;
		homepageUrl?: string;
		license?: string;
		capabilities: string[];
		keywords?: string[];
	},
): Promise<PluginRow> {
	const id = data.id;
	const now = new Date().toISOString();

	await db
		.prepare(
			`INSERT INTO plugins (id, name, description, author_id, repository_url, homepage_url, license, capabilities, keywords, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			data.name,
			data.description ?? null,
			data.authorId,
			data.repositoryUrl ?? null,
			data.homepageUrl ?? null,
			data.license ?? null,
			JSON.stringify(data.capabilities),
			data.keywords ? JSON.stringify(data.keywords) : null,
			now,
			now,
		)
		.run();

	return (await getPlugin(db, id))!;
}

export async function createVersion(
	db: D1Database,
	data: {
		pluginId: string;
		version: string;
		minEmDashVersion?: string;
		bundleKey: string;
		bundleSize: number;
		checksum: string;
		changelog?: string;
		readme?: string;
		hasIcon?: boolean;
		screenshotCount?: number;
		capabilities: string[];
		status?: VersionStatus;
	},
): Promise<PluginVersionRow> {
	const id = generateId();

	await db
		.prepare(
			`INSERT INTO plugin_versions (id, plugin_id, version, min_emdash_version, bundle_key, bundle_size, checksum, changelog, readme, has_icon, screenshot_count, capabilities, status)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			data.pluginId,
			data.version,
			data.minEmDashVersion ?? null,
			data.bundleKey,
			data.bundleSize,
			data.checksum,
			data.changelog ?? null,
			data.readme ?? null,
			data.hasIcon ? 1 : 0,
			data.screenshotCount ?? 0,
			JSON.stringify(data.capabilities),
			data.status ?? "pending",
		)
		.run();

	return (await db
		.prepare("SELECT * FROM plugin_versions WHERE id = ?")
		.bind(id)
		.first<PluginVersionRow>())!;
}

/**
 * Update an existing version row for seed re-publishing.
 * Re-uploads overwrite the R2 bundle, so the DB row must match.
 */
export async function updateVersionForReseed(
	db: D1Database,
	versionId: string,
	data: {
		bundleKey: string;
		bundleSize: number;
		checksum: string;
		changelog?: string;
		readme?: string;
		hasIcon?: boolean;
		screenshotCount?: number;
		capabilities: string[];
	},
): Promise<void> {
	await db
		.prepare(
			`UPDATE plugin_versions
			SET bundle_key = ?, bundle_size = ?, checksum = ?, changelog = ?, readme = ?,
				has_icon = ?, screenshot_count = ?, capabilities = ?, status = 'published',
				published_at = datetime('now')
			WHERE id = ?`,
		)
		.bind(
			data.bundleKey,
			data.bundleSize,
			data.checksum,
			data.changelog ?? null,
			data.readme ?? null,
			data.hasIcon ? 1 : 0,
			data.screenshotCount ?? 0,
			JSON.stringify(data.capabilities),
			versionId,
		)
		.run();
}

/** Update a version's status (used after audit completes). */
export async function updateVersionStatus(
	db: D1Database,
	versionId: string,
	status: VersionStatus,
): Promise<void> {
	await db
		.prepare("UPDATE plugin_versions SET status = ? WHERE id = ?")
		.bind(status, versionId)
		.run();
}

/** Store the Workflow instance ID on a version row. */
export async function setVersionWorkflowId(
	db: D1Database,
	versionId: string,
	workflowId: string,
): Promise<void> {
	await db
		.prepare("UPDATE plugin_versions SET workflow_id = ? WHERE id = ?")
		.bind(workflowId, versionId)
		.run();
}

export async function updatePlugin(
	db: D1Database,
	id: string,
	data: {
		name?: string;
		description?: string;
		repositoryUrl?: string;
		homepageUrl?: string;
		license?: string;
		capabilities?: string[];
		keywords?: string[];
		hasIcon?: boolean;
	},
): Promise<PluginRow | null> {
	const sets: string[] = [];
	const bindings: unknown[] = [];

	if (data.name !== undefined) {
		sets.push("name = ?");
		bindings.push(data.name);
	}
	if (data.description !== undefined) {
		sets.push("description = ?");
		bindings.push(data.description);
	}
	if (data.repositoryUrl !== undefined) {
		sets.push("repository_url = ?");
		bindings.push(data.repositoryUrl);
	}
	if (data.homepageUrl !== undefined) {
		sets.push("homepage_url = ?");
		bindings.push(data.homepageUrl);
	}
	if (data.license !== undefined) {
		sets.push("license = ?");
		bindings.push(data.license);
	}
	if (data.capabilities !== undefined) {
		sets.push("capabilities = ?");
		bindings.push(JSON.stringify(data.capabilities));
	}
	if (data.keywords !== undefined) {
		sets.push("keywords = ?");
		bindings.push(JSON.stringify(data.keywords));
	}
	if (data.hasIcon !== undefined) {
		sets.push("has_icon = ?");
		bindings.push(data.hasIcon ? 1 : 0);
	}

	if (sets.length === 0) return getPlugin(db, id);

	sets.push("updated_at = datetime('now')");
	bindings.push(id);

	await db
		.prepare(`UPDATE plugins SET ${sets.join(", ")} WHERE id = ?`)
		.bind(...bindings)
		.run();

	return getPlugin(db, id);
}

// ── Author queries ──────────────────────────────────────────────

export async function createAuthor(
	db: D1Database,
	data: {
		githubId: string;
		name: string;
		email?: string;
		avatarUrl?: string;
	},
): Promise<AuthorRow> {
	const id = generateId();

	await db
		.prepare(`INSERT INTO authors (id, github_id, name, email, avatar_url) VALUES (?, ?, ?, ?, ?)`)
		.bind(id, data.githubId, data.name, data.email ?? null, data.avatarUrl ?? null)
		.run();

	return (await db.prepare("SELECT * FROM authors WHERE id = ?").bind(id).first<AuthorRow>())!;
}

export async function getAuthorByGithubId(
	db: D1Database,
	githubId: string,
): Promise<AuthorRow | null> {
	return db.prepare("SELECT * FROM authors WHERE github_id = ?").bind(githubId).first<AuthorRow>();
}

const SYSTEM_AUTHOR_ID = "system";

/**
 * Find or create the system author used for seed token publishing.
 * The system author has no GitHub account -- it represents first-party
 * plugins published via the SEED_TOKEN in CI.
 */
export async function findOrCreateSystemAuthor(db: D1Database): Promise<AuthorRow> {
	// INSERT OR IGNORE handles concurrent creation safely (no TOCTOU race).
	await db
		.prepare(
			"INSERT OR IGNORE INTO authors (id, github_id, name, email, avatar_url, verified) VALUES (?, NULL, ?, NULL, NULL, 1)",
		)
		.bind(SYSTEM_AUTHOR_ID, "EmDash")
		.run();

	return (await db
		.prepare("SELECT * FROM authors WHERE id = ?")
		.bind(SYSTEM_AUTHOR_ID)
		.first<AuthorRow>())!;
}

// ── Audit queries ───────────────────────────────────────────────

export async function createAudit(
	db: D1Database,
	data: {
		pluginId: string;
		version: string;
		verdict: string;
		riskScore: number;
		summary: string;
		findings: unknown[];
		model: string;
		durationMs: number;
	},
): Promise<PluginAuditRow> {
	const id = generateId();

	await db
		.prepare(
			`INSERT INTO plugin_audits (id, plugin_id, version, verdict, risk_score, summary, findings, model, duration_ms)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			data.pluginId,
			data.version,
			data.verdict,
			data.riskScore,
			data.summary,
			JSON.stringify(data.findings),
			data.model,
			data.durationMs,
		)
		.run();

	return (await db
		.prepare("SELECT * FROM plugin_audits WHERE id = ?")
		.bind(id)
		.first<PluginAuditRow>())!;
}

export async function createImageAudit(
	db: D1Database,
	data: {
		pluginId: string;
		version: string;
		verdict: string;
		findings: unknown[];
		model: string;
		durationMs: number;
	},
): Promise<PluginImageAuditRow> {
	const id = generateId();

	await db
		.prepare(
			`INSERT INTO plugin_image_audits (id, plugin_id, version, verdict, findings, model, duration_ms)
			VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			id,
			data.pluginId,
			data.version,
			data.verdict,
			JSON.stringify(data.findings),
			data.model,
			data.durationMs,
		)
		.run();

	return (await db
		.prepare("SELECT * FROM plugin_image_audits WHERE id = ?")
		.bind(id)
		.first<PluginImageAuditRow>())!;
}

export async function linkAuditToVersion(
	db: D1Database,
	versionId: string,
	auditId: string,
	verdict: string,
): Promise<void> {
	await db
		.prepare("UPDATE plugin_versions SET audit_id = ?, audit_verdict = ? WHERE id = ?")
		.bind(auditId, verdict, versionId)
		.run();
}

export async function linkImageAuditToVersion(
	db: D1Database,
	versionId: string,
	imageAuditId: string,
	verdict: string,
): Promise<void> {
	await db
		.prepare("UPDATE plugin_versions SET image_audit_id = ?, image_audit_verdict = ? WHERE id = ?")
		.bind(imageAuditId, verdict, versionId)
		.run();
}

// ── Theme queries ───────────────────────────────────────────────

export async function getTheme(db: D1Database, id: string): Promise<ThemeRow | null> {
	return db.prepare("SELECT * FROM themes WHERE id = ?").bind(id).first<ThemeRow>();
}

export async function getThemeWithAuthor(
	db: D1Database,
	id: string,
): Promise<ThemeWithAuthor | null> {
	return db
		.prepare(
			`SELECT t.*, a.name AS author_name, a.avatar_url AS author_avatar_url, a.verified AS author_verified
			FROM themes t
			JOIN authors a ON a.id = t.author_id
			WHERE t.id = ?`,
		)
		.bind(id)
		.first<ThemeWithAuthor>();
}

export async function searchThemes(
	db: D1Database,
	opts: ThemeSearchOptions,
): Promise<{ items: ThemeWithAuthor[]; nextCursor?: string }> {
	const limit = clampLimit(opts.limit);
	const offset = decodeCursor(opts.cursor);

	const conditions: string[] = [];
	const bindings: unknown[] = [];

	if (opts.q) {
		conditions.push("(t.name LIKE ? OR t.description LIKE ? OR t.keywords LIKE ?)");
		const pattern = `%${opts.q}%`;
		bindings.push(pattern, pattern, pattern);
	}

	if (opts.keyword) {
		conditions.push("EXISTS (SELECT 1 FROM json_each(t.keywords) WHERE json_each.value = ?)");
		bindings.push(opts.keyword);
	}

	const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

	let orderBy: string;
	switch (opts.sort) {
		case "name":
			orderBy = "t.name ASC";
			break;
		case "created":
			orderBy = "t.created_at DESC";
			break;
		case "updated":
		default:
			orderBy = "t.updated_at DESC";
			break;
	}

	const query = `
		SELECT t.*, a.name AS author_name, a.avatar_url AS author_avatar_url, a.verified AS author_verified
		FROM themes t
		JOIN authors a ON a.id = t.author_id
		${where}
		ORDER BY ${orderBy}
		LIMIT ? OFFSET ?`;

	bindings.push(limit + 1, offset);

	const result = await db
		.prepare(query)
		.bind(...bindings)
		.all<ThemeWithAuthor>();

	const items = result.results ?? [];
	let nextCursor: string | undefined;

	if (items.length > limit) {
		items.pop();
		nextCursor = encodeCursor(offset + limit);
	}

	return { items, nextCursor };
}

export async function createTheme(
	db: D1Database,
	data: {
		id: string;
		name: string;
		description?: string;
		authorId: string;
		previewUrl: string;
		demoUrl?: string;
		repositoryUrl?: string;
		homepageUrl?: string;
		license?: string;
		keywords?: string[];
	},
): Promise<ThemeRow> {
	const now = new Date().toISOString();

	await db
		.prepare(
			`INSERT INTO themes (id, name, description, author_id, preview_url, demo_url, repository_url, homepage_url, license, keywords, created_at, updated_at)
			VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(
			data.id,
			data.name,
			data.description ?? null,
			data.authorId,
			data.previewUrl,
			data.demoUrl ?? null,
			data.repositoryUrl ?? null,
			data.homepageUrl ?? null,
			data.license ?? null,
			data.keywords ? JSON.stringify(data.keywords) : null,
			now,
			now,
		)
		.run();

	return (await getTheme(db, data.id))!;
}

export async function updateTheme(
	db: D1Database,
	id: string,
	data: {
		name?: string;
		description?: string;
		previewUrl?: string;
		demoUrl?: string;
		repositoryUrl?: string;
		homepageUrl?: string;
		license?: string;
		keywords?: string[];
		hasThumbnail?: boolean;
		screenshotCount?: number;
	},
): Promise<ThemeRow | null> {
	const sets: string[] = [];
	const bindings: unknown[] = [];

	if (data.name !== undefined) {
		sets.push("name = ?");
		bindings.push(data.name);
	}
	if (data.description !== undefined) {
		sets.push("description = ?");
		bindings.push(data.description);
	}
	if (data.previewUrl !== undefined) {
		sets.push("preview_url = ?");
		bindings.push(data.previewUrl);
	}
	if (data.demoUrl !== undefined) {
		sets.push("demo_url = ?");
		bindings.push(data.demoUrl);
	}
	if (data.repositoryUrl !== undefined) {
		sets.push("repository_url = ?");
		bindings.push(data.repositoryUrl);
	}
	if (data.homepageUrl !== undefined) {
		sets.push("homepage_url = ?");
		bindings.push(data.homepageUrl);
	}
	if (data.license !== undefined) {
		sets.push("license = ?");
		bindings.push(data.license);
	}
	if (data.keywords !== undefined) {
		sets.push("keywords = ?");
		bindings.push(JSON.stringify(data.keywords));
	}
	if (data.hasThumbnail !== undefined) {
		sets.push("has_thumbnail = ?");
		bindings.push(data.hasThumbnail ? 1 : 0);
	}
	if (data.screenshotCount !== undefined) {
		sets.push("screenshot_count = ?");
		bindings.push(data.screenshotCount);
	}

	if (sets.length === 0) return getTheme(db, id);

	sets.push("updated_at = datetime('now')");
	bindings.push(id);

	await db
		.prepare(`UPDATE themes SET ${sets.join(", ")} WHERE id = ?`)
		.bind(...bindings)
		.run();

	return getTheme(db, id);
}
