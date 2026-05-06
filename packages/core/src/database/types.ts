import type { Generated } from "kysely";

// Core database tables
// Note: Content tables (ec_posts, ec_pages, etc.) are created dynamically
// by the SchemaRegistry. They are not defined in this type file.

export interface RevisionTable {
	id: string;
	collection: string; // e.g., 'posts'
	entry_id: string; // ID in the ec_* table
	data: string; // JSON snapshot
	author_id: string | null;
	created_at: Generated<string>;
}

export interface TaxonomyTable {
	id: string;
	name: string;
	slug: string;
	label: string;
	parent_id: string | null;
	data: string | null; // JSON
	locale: Generated<string>; // e.g. 'en', 'es', 'fr'
	translation_group: string | null; // shared across translations of the same term
}

export interface ContentTaxonomyTable {
	collection: string; // e.g., 'posts'
	entry_id: string; // ID in the ec_* table
	taxonomy_id: string; // stores taxonomies.translation_group (locale-agnostic)
}

export interface TaxonomyDefTable {
	id: string;
	name: string;
	label: string;
	label_singular: string | null;
	hierarchical: number; // 0 or 1 (SQLite boolean)
	collections: string | null; // JSON array
	created_at: Generated<string>;
	locale: Generated<string>;
	translation_group: string | null;
}

export interface MediaTable {
	id: string;
	filename: string;
	mime_type: string;
	size: number | null;
	width: number | null;
	height: number | null;
	alt: string | null;
	caption: string | null;
	storage_key: string;
	status: string; // 'pending' | 'ready' | 'failed'
	content_hash: string | null; // xxHash64 for deduplication
	blurhash: string | null;
	dominant_color: string | null;
	created_at: Generated<string>;
	author_id: string | null;
}

export interface UserTable {
	id: string;
	email: string;
	name: string | null;
	avatar_url: string | null;
	role: number; // RoleLevel: 10=SUBSCRIBER, 20=CONTRIBUTOR, 30=AUTHOR, 40=EDITOR, 50=ADMIN
	email_verified: number; // 0 or 1
	data: string | null; // JSON
	disabled: Generated<number>; // 0 or 1
	created_at: Generated<string>;
	updated_at: Generated<string>;
}

export interface CredentialTable {
	id: string; // Base64url credential ID
	user_id: string;
	public_key: Uint8Array; // SEC1 or PKIX encoded public key
	algorithm: number;
	counter: number;
	device_type: string; // 'singleDevice' | 'multiDevice'
	backed_up: number; // 0 or 1
	transports: string | null; // JSON array
	name: string | null;
	created_at: Generated<string>;
	last_used_at: Generated<string>;
}

export interface AuthTokenTable {
	hash: string; // SHA-256 hash of token
	user_id: string | null;
	email: string | null;
	type: string; // 'magic_link' | 'email_verify' | 'invite' | 'recovery'
	role: number | null; // For invites
	invited_by: string | null;
	expires_at: string;
	created_at: Generated<string>;
}

export interface OAuthAccountTable {
	provider: string;
	provider_account_id: string;
	user_id: string;
	created_at: Generated<string>;
}

export interface AllowedDomainTable {
	domain: string;
	default_role: number;
	enabled: number; // 0 or 1
	created_at: Generated<string>;
}

export interface AuthChallengeTable {
	challenge: string; // Base64url challenge (PK)
	type: string; // 'registration' | 'authentication'
	user_id: string | null; // For registration, the user being registered
	data: string | null; // JSON for additional context
	expires_at: string;
	created_at: Generated<string>;
}

// API Tokens (programmatic access)

export interface ApiTokenTable {
	id: string;
	name: string;
	token_hash: string;
	prefix: string; // First 8 chars for identification (e.g. "ec_pat_Ab")
	user_id: string;
	scopes: string; // JSON array of scope strings
	expires_at: string | null; // null = no expiry
	last_used_at: string | null;
	created_at: Generated<string>;
}

export interface OAuthTokenTable {
	token_hash: string; // SHA-256 hash (PK)
	token_type: string; // 'access' | 'refresh'
	user_id: string;
	scopes: string; // JSON array
	client_type: string; // 'cli' | 'mcp'
	expires_at: string;
	refresh_token_hash: string | null; // links access → refresh
	client_id: string | null; // Which OAuth client obtained this token
	created_at: Generated<string>;
}

export interface AuthorizationCodeTable {
	code_hash: string; // SHA-256 hash (PK)
	client_id: string; // CIMD URL or opaque string
	redirect_uri: string; // Must match exactly on exchange
	user_id: string;
	scopes: string; // JSON array
	code_challenge: string; // S256 challenge
	code_challenge_method: string; // 'S256'
	resource: string | null; // RFC 8707 resource indicator
	expires_at: string;
	created_at: Generated<string>;
}

export interface OAuthClientTable {
	id: string; // Client ID (e.g. URL or opaque string)
	name: string; // Human-readable name
	redirect_uris: string; // JSON array of allowed redirect URIs
	scopes: string | null; // JSON array of allowed scopes (null = all)
	created_at: Generated<string>;
	updated_at: Generated<string>;
}

export interface DeviceCodeTable {
	device_code: string; // opaque, high-entropy (PK)
	user_code: string; // short, human-readable (ABCD-1234)
	scopes: string; // JSON array
	user_id: string | null; // set when user authorizes
	status: string; // 'pending' | 'authorized' | 'denied' | 'expired'
	expires_at: string;
	interval: number; // polling interval in seconds
	last_polled_at: string | null; // RFC 8628 slow_down tracking
	created_at: Generated<string>;
}

export interface OptionTable {
	name: string;
	value: string; // JSON
}

export interface AuditLogTable {
	id: string;
	timestamp: Generated<string>;
	actor_id: string | null;
	actor_ip: string | null;
	action: string;
	resource_type: string | null;
	resource_id: string | null;
	details: string | null; // JSON
	status: string | null;
}

export interface MigrationTable {
	name: string;
	timestamp: string;
}

// Schema Registry Tables

export interface CollectionTable {
	id: string;
	slug: string;
	label: string;
	label_singular: string | null;
	description: string | null;
	icon: string | null;
	supports: string | null; // JSON array
	source: string | null;
	search_config: string | null; // JSON: { enabled: boolean, weights: Record<string, number> }
	has_seo: number; // 0 or 1 — opt-in SEO fields for this collection
	url_pattern: string | null; // URL pattern with {slug} placeholder (e.g. "/blog/{slug}")
	comments_enabled: Generated<number>; // 0 or 1
	comments_moderation: Generated<string>; // 'all' | 'first_time' | 'none'
	comments_closed_after_days: Generated<number>; // 0 = never close
	comments_auto_approve_users: Generated<number>; // 0 or 1
	created_at: Generated<string>;
	updated_at: Generated<string>;
}

export interface SeoTable {
	collection: string;
	content_id: string;
	seo_title: string | null;
	seo_description: string | null;
	seo_image: string | null;
	seo_canonical: string | null;
	seo_no_index: number; // 0 or 1
	created_at: Generated<string>;
	updated_at: Generated<string>;
}

export interface FieldTable {
	id: string;
	collection_id: string;
	slug: string;
	label: string;
	type: string;
	column_type: string;
	required: number; // boolean as 0/1
	unique: number; // boolean as 0/1
	default_value: string | null; // JSON
	validation: string | null; // JSON
	widget: string | null;
	options: string | null; // JSON
	sort_order: number;
	searchable: Generated<number>; // boolean as 0/1, defaults to 0
	translatable: Generated<number>; // boolean as 0/1, defaults to 1
	created_at: Generated<string>;
}

// Plugin Storage Tables

export interface PluginStorageTable {
	plugin_id: string;
	collection: string;
	id: string;
	data: string; // JSON
	created_at: Generated<string>;
	updated_at: Generated<string>;
}

export interface PluginStateTable {
	plugin_id: string;
	version: string;
	status: string; // 'installed' | 'active' | 'inactive'
	installed_at: Generated<string>;
	activated_at: string | null;
	deactivated_at: string | null;
	data: string | null; // JSON
	source: Generated<string>; // 'config' | 'marketplace'
	marketplace_version: string | null;
	display_name: string | null;
	description: string | null;
}

export interface PluginIndexTable {
	plugin_id: string;
	collection: string;
	index_name: string;
	fields: string; // JSON array of field paths
	created_at: Generated<string>;
}

// Navigation Menus

export interface MenuTable {
	id: string;
	name: string;
	label: string;
	created_at: Generated<string>;
	updated_at: Generated<string>;
	locale: Generated<string>;
	translation_group: string | null;
}

export interface MenuItemTable {
	id: string;
	menu_id: string;
	parent_id: string | null;
	sort_order: number;
	type: string;
	reference_collection: string | null;
	reference_id: string | null; // stores translation_group of referenced content/term
	custom_url: string | null;
	label: string;
	title_attr: string | null;
	target: string | null;
	css_classes: string | null;
	created_at: Generated<string>;
	locale: Generated<string>;
	translation_group: string | null;
}

// Widget Areas

export interface WidgetAreaTable {
	id: string;
	name: string;
	label: string;
	description: string | null;
	created_at: Generated<string>;
}

export interface WidgetTable {
	id: string;
	area_id: string;
	sort_order: number;
	type: string; // 'content', 'menu', 'component'
	title: string | null;
	content: string | null; // JSON: Portable Text
	menu_name: string | null;
	component_id: string | null;
	component_props: string | null; // JSON
	created_at: Generated<string>;
}

// Cron Tasks

export interface CronTaskTable {
	id: string;
	plugin_id: string;
	task_name: string;
	schedule: string;
	is_oneshot: number; // 0 or 1
	data: string | null; // JSON
	next_run_at: string;
	last_run_at: string | null;
	status: string; // 'idle' | 'running'
	locked_at: string | null;
	enabled: number; // 0 or 1
	created_at: Generated<string>;
}

// Comments

export interface CommentTable {
	id: string;
	collection: string;
	content_id: string;
	parent_id: string | null;
	author_name: string;
	author_email: string;
	author_user_id: string | null;
	body: string;
	status: string; // 'pending' | 'approved' | 'spam' | 'trash'
	ip_hash: string | null;
	user_agent: string | null;
	moderation_metadata: string | null; // JSON
	created_at: Generated<string>;
	updated_at: Generated<string>;
}

// Sections

export interface SectionTable {
	id: string;
	slug: string;
	title: string;
	description: string | null;
	keywords: string | null; // JSON array
	content: string; // JSON: Portable Text array
	preview_media_id: string | null;
	source: string; // 'theme', 'user', 'import'
	theme_id: string | null;
	created_at: Generated<string>;
	updated_at: Generated<string>;
}

// Database schema
// Note: ec_* content tables are dynamic and not part of this type
export interface Database {
	revisions: RevisionTable;
	taxonomies: TaxonomyTable;
	content_taxonomies: ContentTaxonomyTable;
	_emdash_taxonomy_defs: TaxonomyDefTable;
	media: MediaTable;
	users: UserTable;
	credentials: CredentialTable;
	auth_tokens: AuthTokenTable;
	oauth_accounts: OAuthAccountTable;
	allowed_domains: AllowedDomainTable;
	auth_challenges: AuthChallengeTable;
	options: OptionTable;
	audit_logs: AuditLogTable;
	_emdash_migrations: MigrationTable;
	_emdash_collections: CollectionTable;
	_emdash_fields: FieldTable;
	_plugin_storage: PluginStorageTable;
	_plugin_state: PluginStateTable;
	_plugin_indexes: PluginIndexTable;
	_emdash_menus: MenuTable;
	_emdash_menu_items: MenuItemTable;
	_emdash_widget_areas: WidgetAreaTable;
	_emdash_widgets: WidgetTable;
	_emdash_sections: SectionTable;
	_emdash_api_tokens: ApiTokenTable;
	_emdash_oauth_tokens: OAuthTokenTable;
	_emdash_device_codes: DeviceCodeTable;
	_emdash_authorization_codes: AuthorizationCodeTable;
	_emdash_oauth_clients: OAuthClientTable;
	_emdash_seo: SeoTable;
	_emdash_cron_tasks: CronTaskTable;
	_emdash_comments: CommentTable;
	_emdash_redirects: RedirectTable;
	_emdash_404_log: NotFoundLogTable;
	_emdash_bylines: BylineTable;
	_emdash_content_bylines: ContentBylineTable;
	_emdash_rate_limits: RateLimitTable;
}

export type MediaRow = {
	id: string;
	filename: string;
	mime_type: string;
	size: number | null;
	width: number | null;
	height: number | null;
	alt: string | null;
	caption: string | null;
	storage_key: string;
	status: string; // 'pending' | 'ready' | 'failed'
	content_hash: string | null; // xxHash64 for deduplication
	blurhash: string | null;
	dominant_color: string | null;
	created_at: string;
	author_id: string | null;
};

export interface RedirectTable {
	id: string;
	source: string;
	destination: string;
	type: number; // 301, 302, 307, 308
	is_pattern: number; // boolean: source contains [param] or [...splat]
	enabled: number; // boolean
	hits: number;
	last_hit_at: string | null;
	group_name: string | null;
	auto: number; // boolean: system-generated from slug change
	created_at: string;
	updated_at: string;
}

export interface NotFoundLogTable {
	id: string;
	path: string;
	referrer: string | null;
	user_agent: string | null;
	ip: string | null;
	hits: number;
	/**
	 * Migration 035 adds this as a nullable column (SQLite can't add a
	 * NOT NULL column with a non-constant default to an existing table).
	 * The `log404` upsert always writes a value, so new and updated rows
	 * always have one, but existing rows pre-migration were backfilled
	 * without a NOT NULL constraint. Typed as nullable to match the schema.
	 */
	last_seen_at: string | null;
	created_at: string;
}

export interface BylineTable {
	id: string;
	slug: string;
	display_name: string;
	bio: string | null;
	avatar_media_id: string | null;
	website_url: string | null;
	user_id: string | null;
	is_guest: number;
	created_at: Generated<string>;
	updated_at: Generated<string>;
}

export interface ContentBylineTable {
	id: string;
	collection_slug: string;
	content_id: string;
	byline_id: string;
	sort_order: number;
	role_label: string | null;
	created_at: Generated<string>;
}

// Rate Limits

export interface RateLimitTable {
	key: string; // {ip}:{endpoint}
	window: string; // ISO timestamp truncated to window size
	count: number;
}
