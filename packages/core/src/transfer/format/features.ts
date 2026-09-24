/**
 * Site package feature registry.
 *
 * `manifest.features` lists every feature the package uses (sorted);
 * `manifest.requiredFeatures` is the subset a reader must understand to import
 * it. Readers reject a package whose required features include one they do not
 * know. Every v1 feature is required when present except `comment_reactions`.
 */

import { compareUtf16 } from "./canonical.js";
import type { RecordKind } from "./kinds.js";

export const SITE_PACKAGE_FEATURES = [
	"bylines",
	"comment_reactions",
	"comments",
	"content",
	"i18n",
	"media",
	"menus",
	"principals",
	"redirects",
	"relations",
	"revisions",
	"schema",
	"sections",
	"seo",
	"settings",
	"taxonomies",
	"trash",
	"widgets",
] as const;

export type SitePackageFeature = (typeof SITE_PACKAGE_FEATURES)[number];

export const OPTIONAL_FEATURES: ReadonlySet<SitePackageFeature> = new Set(["comment_reactions"]);

const FEATURE_SET: ReadonlySet<string> = new Set(SITE_PACKAGE_FEATURES);

export function isSitePackageFeature(value: string): value is SitePackageFeature {
	return FEATURE_SET.has(value);
}

/**
 * The feature a record kind belongs to. A package may only contain records of
 * a kind whose feature it declares. `i18n` (more than one locale in use) and
 * `trash` (entries with `deletedAt`) have no kind of their own.
 */
export const KIND_FEATURE: Readonly<Record<RecordKind, SitePackageFeature>> = Object.freeze({
	principal: "principals",
	block_type: "schema",
	block_type_version: "schema",
	collection: "schema",
	field: "schema",
	taxonomy_def: "taxonomies",
	relation: "relations",
	byline_field: "bylines",
	media_folder: "media",
	media: "media",
	term: "taxonomies",
	byline: "bylines",
	byline_field_value: "bylines",
	byline_field_group_value: "bylines",
	revision: "revisions",
	entry: "content",
	content_term: "taxonomies",
	content_byline: "bylines",
	content_reference: "relations",
	seo: "seo",
	menu: "menus",
	menu_item: "menus",
	widget_area: "widgets",
	widget: "widgets",
	section: "sections",
	redirect: "redirects",
	comment: "comments",
	comment_reaction: "comment_reactions",
	setting: "settings",
});

/** Required features derived from a feature list (sorted). */
export function requiredFeaturesFor(features: readonly SitePackageFeature[]): SitePackageFeature[] {
	return [...new Set(features)]
		.filter((feature) => !OPTIONAL_FEATURES.has(feature))
		.toSorted(compareUtf16);
}

/** Required features this reader does not understand (empty when supported). */
export function unsupportedRequiredFeatures(requiredFeatures: readonly string[]): string[] {
	return requiredFeatures.filter((feature) => !isSitePackageFeature(feature));
}
