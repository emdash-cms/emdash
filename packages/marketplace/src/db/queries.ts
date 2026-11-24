import type {
	PluginSearchResult,
	PluginVersionRow,
	PluginWithAuthor,
	SearchOptions,
	ThemeSearchOptions,
	ThemeWithAuthor,
} from "./types.js";

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
			orderBy = "p.install_count DESC, p.created_at DESC";
			break;
	}

	const query = `
		SELECT p.*, a.name AS author_name, a.avatar_url AS author_avatar_url, a.verified AS author_verified,
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

// ── Theme queries ───────────────────────────────────────────────

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
