export interface AuthorRow {
	id: string;
	github_id: string | null;
	name: string;
	email: string | null;
	avatar_url: string | null;
	verified: number;
	created_at: string;
}

export interface PluginRow {
	id: string;
	name: string;
	description: string | null;
	author_id: string;
	repository_url: string | null;
	homepage_url: string | null;
	license: string | null;
	capabilities: string;
	keywords: string | null;
	has_icon: number;
	install_count: number;
	created_at: string;
	updated_at: string;
}

export type VersionStatus = "pending" | "published" | "flagged" | "rejected";

export interface PluginVersionRow {
	id: string;
	plugin_id: string;
	version: string;
	min_emdash_version: string | null;
	bundle_key: string;
	bundle_size: number;
	checksum: string;
	changelog: string | null;
	readme: string | null;
	has_icon: number;
	screenshot_count: number;
	capabilities: string;
	status: VersionStatus;
	workflow_id: string | null;
	audit_id: string | null;
	audit_verdict: string | null;
	image_audit_id: string | null;
	image_audit_verdict: string | null;
	published_at: string;
}

export interface PluginAuditRow {
	id: string;
	plugin_id: string;
	version: string;
	verdict: string;
	risk_score: number;
	summary: string;
	findings: string;
	model: string;
	duration_ms: number;
	created_at: string;
}

export interface PluginImageAuditRow {
	id: string;
	plugin_id: string;
	version: string;
	verdict: string;
	findings: string;
	model: string;
	duration_ms: number;
	created_at: string;
}

export interface InstallRow {
	plugin_id: string;
	site_hash: string;
	version: string;
	installed_at: string;
}

export interface PluginWithAuthor extends PluginRow {
	author_name: string;
	author_avatar_url: string | null;
	author_verified: number;
}

export interface PluginSearchResult extends PluginWithAuthor {
	install_count: number;
	latest_version: string | null;
	latest_status: VersionStatus | null;
	latest_audit_verdict: string | null;
	latest_image_audit_verdict: string | null;
	latest_audit_risk_score: number | null;
}

export type SortOption = "installs" | "updated" | "created" | "name";

export interface SearchOptions {
	q?: string;
	capability?: string;
	sort?: SortOption;
	cursor?: string;
	limit?: number;
}

// ── Theme types ─────────────────────────────────────────────────

export interface ThemeRow {
	id: string;
	name: string;
	description: string | null;
	author_id: string;
	preview_url: string;
	demo_url: string | null;
	repository_url: string | null;
	homepage_url: string | null;
	license: string | null;
	keywords: string | null;
	has_thumbnail: number;
	screenshot_count: number;
	created_at: string;
	updated_at: string;
}

export interface ThemeWithAuthor extends ThemeRow {
	author_name: string;
	author_avatar_url: string | null;
	author_verified: number;
}

export type ThemeSortOption = "name" | "created" | "updated";

export interface ThemeSearchOptions {
	q?: string;
	keyword?: string;
	sort?: ThemeSortOption;
	cursor?: string;
	limit?: number;
}
