import type { I18n, MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import type { PortableDomainBlocker, ScaffoldItem } from "../../../lib/api/transfer.js";
import type { PackageErrorReason } from "../../../lib/transfer-package.js";

const RECORD_KIND_LABELS: Record<string, MessageDescriptor> = {
	principal: msg`Authors`,
	block_type: msg`Block types`,
	block_type_version: msg`Block type versions`,
	collection: msg`Collections`,
	field: msg`Fields`,
	taxonomy_def: msg`Taxonomies`,
	relation: msg`Relations`,
	byline_field: msg`Byline fields`,
	media_folder: msg`Media folders`,
	media: msg`Media`,
	term: msg`Terms`,
	byline: msg`Bylines`,
	byline_field_value: msg`Byline field values`,
	byline_field_group_value: msg`Byline field group values`,
	revision: msg`Revisions`,
	entry: msg`Entries`,
	content_term: msg`Term assignments`,
	content_byline: msg`Byline credits`,
	content_reference: msg`Content references`,
	seo: msg`SEO settings`,
	menu: msg`Menus`,
	menu_item: msg`Menu items`,
	widget_area: msg`Widget areas`,
	widget: msg`Widgets`,
	section: msg`Sections`,
	redirect: msg`Redirects`,
	comment: msg`Comments`,
	comment_reaction: msg`Comment reactions`,
	setting: msg`Site settings`,
};

export function recordKindLabel(i18n: I18n, kind: string): string {
	const label = RECORD_KIND_LABELS[kind];
	return label ? i18n._(label) : kind;
}

/** Display order for per-kind counts: the package's own record order. */
export const RECORD_KIND_ORDER = Object.keys(RECORD_KIND_LABELS);

const STAGE_LABELS: Record<string, MessageDescriptor> = {
	export_records: msg`Reading content`,
	export_media: msg`Checking media files`,
	export_finalize: msg`Writing the file index`,
	export_validate: msg`Validating the package`,
	analyze_structure: msg`Checking package structure`,
	analyze_records: msg`Checking records`,
	analyze_references: msg`Checking references`,
	analyze_target: msg`Checking this site`,
	reserve: msg`Preparing this site`,
	clear_scaffold: msg`Removing starter content`,
	schema: msg`Creating collections and fields`,
	media: msg`Copying media`,
	terms_bylines: msg`Importing terms and bylines`,
	content: msg`Importing content`,
	relations: msg`Linking content`,
	presentation: msg`Importing menus, widgets, and settings`,
	rebuild: msg`Rebuilding search and caches`,
	verify: msg`Verifying the import`,
};

export function stageLabel(i18n: I18n, stage: string | null): string | null {
	if (!stage) return null;
	const label = STAGE_LABELS[stage];
	return label ? i18n._(label) : stage;
}

const TABLE_LABELS: Record<string, MessageDescriptor> = {
	taxonomies: msg`Taxonomy terms`,
	content_taxonomies: msg`Term assignments`,
	_emdash_relations: msg`Relations`,
	_emdash_content_references: msg`Content references`,
	_emdash_bylines: msg`Bylines`,
	_emdash_byline_fields: msg`Byline fields`,
	_emdash_byline_field_values: msg`Byline field values`,
	_emdash_byline_field_group_values: msg`Byline field values`,
	_emdash_content_bylines: msg`Byline credits`,
	media: msg`Media`,
	media_folders: msg`Media folders`,
	revisions: msg`Revisions`,
	_emdash_seo: msg`SEO settings`,
	_emdash_comments: msg`Comments`,
	_emdash_comment_reactions: msg`Comment reactions`,
	_emdash_redirects: msg`Redirects`,
	_emdash_widgets: msg`Widgets`,
	_emdash_menu_items: msg`Menu items`,
	_emdash_sections: msg`Sections`,
};

export function domainBlockerLabel(i18n: I18n, blocker: PortableDomainBlocker): string {
	switch (blocker.code) {
		case "table_not_empty": {
			const label = TABLE_LABELS[blocker.table];
			const name = label ? i18n._(label) : blocker.table;
			return i18n._(msg`${name}: this site already has some`);
		}
		case "collection_has_entries":
			return i18n._(msg`Collection “${blocker.slug}” has entries`);
		case "collection_not_seeded":
			return i18n._(msg`Collection “${blocker.slug}” was created on this site`);
		case "block_type_not_seeded":
			return i18n._(msg`Block type “${blocker.slug}” was created on this site`);
		case "taxonomy_def_not_scaffold":
			return i18n._(msg`Taxonomy “${blocker.name}” is used by content on this site`);
		default:
			return i18n._(msg`This site already has content`);
	}
}

/** Plan blockers and warnings; receipts carry the plan's warnings. */
const ISSUE_LABELS: Record<string, MessageDescriptor> = {
	package_invalid: msg`The package is not valid`,
	unsupported_format: msg`The package format is not supported by this version of EmDash`,
	unsupported_feature: msg`The package needs a feature this version of EmDash does not support`,
	limit_exceeded: msg`The package is larger than this site allows`,
	file_missing: msg`A package file is missing`,
	file_mismatch: msg`A package file does not match the manifest`,
	record_invalid: msg`A record in the package is not valid`,
	record_count_mismatch: msg`Record counts do not match the manifest`,
	record_order_invalid: msg`Records are out of order`,
	duplicate_id: msg`The package contains a duplicate ID`,
	dangling_reference: msg`A record refers to something missing from the package`,
	reference_cycle: msg`Records refer to each other in a loop`,
	media_ref_invalid: msg`Content refers to media in an invalid way`,
	media_blob_missing: msg`A media file is missing from the package`,
	media_blob_too_large: msg`A media file is larger than this site accepts`,
	target_not_empty: msg`This site already has content`,
	locale_not_configured: msg`The package uses a locale this site does not have`,
	field_type_unknown: msg`The package uses a field type this site does not know`,
	principal_conflict: msg`Two authors with bylines in the same locale are mapped to the same user`,
	integer_out_of_range: msg`A number is too large for this site’s database`,
	value_constraint_violation: msg`A value does not fit this site’s database`,
	unique_violation: msg`Two records have the same value where it must be unique`,
	media_row_missing: msg`Content refers to media that is not in the package`,
	media_provider_external: msg`Some media is hosted by an external provider`,
	soft_reference_dangling: msg`Some references point to content that is not in the package`,
	redirect_loops_unchecked: msg`There are too many redirects to check them for loops before importing`,
	issues_truncated: msg`More issues were found than are listed`,
};

export function issueLabel(i18n: I18n, code: string): string {
	const label = ISSUE_LABELS[code];
	return label ? i18n._(label) : code;
}

/** Every way the imported site differs from the source site, by transformation code. */
const TRANSFORMATION_LABELS: Record<string, MessageDescriptor> = {
	soft_orphan_dropped: msg`Unused references were left out`,
	avatar_nulled: msg`Some byline avatars were left out`,
	redirect_duplicate_dropped: msg`Duplicate redirects were left out`,
	media_not_ready_dropped: msg`Unfinished media uploads were left out`,
	media_url_relativized: msg`Media links were made relative`,
	orphan_dropped: msg`Records without a parent were left out`,
	orphan_reference_nulled: msg`Broken references were cleared`,
	media_ref_unlinked: msg`Some media links could not be matched to files`,
	unknown_storage_key: msg`Some content links to media files the source site doesn’t have; those links won’t work`,
	principal_mapped: msg`Authors will be assigned to users on this site`,
	principal_unmapped: msg`Some content will have no author`,
	seeded_scaffold_removed: msg`Starter content will be removed`,
	redirect_loop_disabled: msg`Redirects that loop will be imported turned off`,
	search_unsupported: msg`Search will be turned off for some collections`,
	float4_rounded: msg`Some decimal numbers will be rounded`,
	locale_recased: msg`Locales will use this site’s capitalization`,
};

/** A localized label for a declared transformation code. */
export function transformationLabel(i18n: I18n, code: string): string {
	const label = TRANSFORMATION_LABELS[code];
	return label ? i18n._(label) : code;
}

const ERROR_LABELS: Record<string, MessageDescriptor> = {
	TRANSFER_EXPORT_CONCURRENT_WRITES: msg`The site kept changing while it was exported. Try again when editing is quieter.`,
	TRANSFER_TARGET_NOT_EMPTY: msg`This site already has content, so it can’t receive an import.`,
	TRANSFER_MANIFEST_INVALID: msg`The package manifest is not valid.`,
	TRANSFER_UNSUPPORTED_FORMAT: msg`This package was made by a newer or different version of EmDash.`,
	TRANSFER_UNSUPPORTED_FEATURE: msg`This package needs features this version of EmDash does not support.`,
	TRANSFER_FILE_DIGEST_MISMATCH: msg`A file does not match the package manifest. The package may be damaged.`,
	TRANSFER_FILE_SIZE_MISMATCH: msg`A file is not the size the package manifest declares. The package may be damaged.`,
	TRANSFER_CONTAINER_INVALID: msg`The file is not a valid EmDash site package.`,
	TRANSFER_LIMIT_EXCEEDED: msg`The package is larger than this site allows.`,
	TRANSFER_VERIFICATION_FAILED: msg`The imported site did not match the package when it was checked.`,
	TRANSFER_PLAN_BLOCKED: msg`The import has blockers that must be resolved first.`,
	TRANSFER_PLAN_DIGEST_MISMATCH: msg`The import plan changed. Review it again before importing.`,
	TRANSFER_PACKAGE_DIGEST_MISMATCH: msg`The package changed. Choose it again before importing.`,
	TRANSFER_IDEMPOTENCY_CONFLICT: msg`Another import is already using this package.`,
	TRANSFER_EXPIRED: msg`This operation expired. Start again.`,
	TRANSFER_RUNTIME_MISMATCH: msg`The server was updated while this ran. Reload the page and try again.`,
	TRANSFER_STORAGE_ERROR: msg`The site’s storage could not be read or written.`,
};

/** A localized explanation for a stored operation error code, if one is known. */
export function transferErrorLabel(i18n: I18n, code: string | null): string | null {
	if (!code) return null;
	const label = ERROR_LABELS[code];
	return label ? i18n._(label) : null;
}

const PACKAGE_ERROR_LABELS: Record<PackageErrorReason, MessageDescriptor> = {
	unreadable: msg`This file is not a readable EmDash site package.`,
	manifest_first: msg`This file is not an EmDash site package: it must start with manifest.json.`,
	manifest_invalid: msg`The package’s file index is not valid.`,
	not_a_file: msg`The package contains an entry that is not a regular file.`,
	invalid_path: msg`The package contains a file that is not part of the site package format.`,
	duplicate_path: msg`The package contains the same file twice.`,
	too_large: msg`The package contains a file larger than this site accepts.`,
	size_mismatch: msg`A file in the package is not the size the manifest declares.`,
	digest_mismatch: msg`A file in the package does not match the manifest. The package may be damaged.`,
	different_package: msg`This is not the package the import was started with. Choose the same file again.`,
	files_missing: msg`Some files listed in the manifest are not in this package.`,
	export_changed: msg`The export’s files no longer match the export. Start a new export.`,
};

export function packageErrorLabel(i18n: I18n, reason: PackageErrorReason): string {
	return i18n._(PACKAGE_ERROR_LABELS[reason]);
}

/** Scaffold item types in the order the review lists them. */
export const SCAFFOLD_TYPE_ORDER: readonly ScaffoldItem["type"][] = [
	"collection",
	"block_type",
	"taxonomy_def",
	"term",
	"menu",
	"menu_item",
	"widget_area",
	"widget",
	"section",
];

/**
 * The name a person would recognize a scaffold item by. Menu items and
 * widgets name their menu or widget area when `siblings` includes it.
 */
export function scaffoldItemName(
	i18n: I18n,
	item: ScaffoldItem,
	siblings: ReadonlyMap<string, ScaffoldItem>,
): string {
	switch (item.type) {
		case "collection":
		case "block_type":
		case "section":
			return item.slug;
		case "taxonomy_def":
		case "term":
		case "menu":
		case "widget_area":
			return item.name;
		case "menu_item": {
			const menu = siblings.get(`menu:${item.menuId}`);
			const label = item.label;
			if (menu?.type !== "menu") return label;
			const menuName = menu.name;
			return i18n._(msg`${label} in ${menuName}`);
		}
		case "widget": {
			const area = siblings.get(`widget_area:${item.areaId}`);
			const widgetType = item.widgetType;
			if (area?.type !== "widget_area") return widgetType;
			const areaName = area.name;
			return i18n._(msg`${widgetType} in ${areaName}`);
		}
	}
}

/** `sha256:abcdef…` shortened for display; the full value stays copyable. */
export function shortDigest(digest: string | null | undefined): string {
	if (!digest) return "";
	const hex = digest.startsWith("sha256:") ? digest.slice(7) : digest;
	return `sha256:${hex.slice(0, 12)}…`;
}
