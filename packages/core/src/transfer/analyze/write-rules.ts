/**
 * Values the site's own write paths refuse. The importer writes rows
 * directly, so analysis applies the same validators the admin API does and
 * blocks a package holding a value that API would reject.
 */

import { httpUrl } from "../../api/schemas/common.js";
import { safeHref } from "../../api/schemas/menus.js";
import { createRedirectBody } from "../../api/schemas/redirects.js";
import { coerceFieldValue } from "../../database/repositories/byline.js";
import { EmDashValidationError } from "../../database/repositories/types.js";
import { isPattern, validateDestinationParams, validatePattern } from "../../redirects/patterns.js";
import { isTerminalStatus } from "../../redirects/status.js";
import type { BylineFieldType } from "../../schema/types.js";
import { compileUrlPattern } from "../../schema/url-pattern.js";
import type { RedirectRecord, SitePackageRecord } from "../format/kinds.js";
import type { ValueIssue } from "./values.js";

/** What the byline field write path checks a value against. */
export interface BylineFieldFacts {
	type: BylineFieldType;
	/** Choices of a `select` field. */
	options?: string[];
}

/** Facts from earlier records that some rules need. */
export interface WriteRuleFacts {
	/** Byline fields by id. */
	bylineFields: ReadonlyMap<string, BylineFieldFacts>;
}

function rejected(property: string, message: string): ValueIssue {
	return { code: "value_constraint_violation", message, property };
}

const REDIRECT_BODY_MESSAGES: Record<string, string> = {
	source: "Redirect source is not a path on this site",
	destination: "Redirect destination is not a path on this site",
	type: "Redirect type is not supported",
};

function redirectIssues(record: RedirectRecord): ValueIssue[] {
	const issues: ValueIssue[] = [];
	const body = createRedirectBody.safeParse({
		source: record.source,
		destination: record.destination,
		type: record.type,
	});
	if (!body.success) {
		const properties = new Set(body.error.issues.map((issue) => String(issue.path[0])));
		for (const [property, message] of Object.entries(REDIRECT_BODY_MESSAGES)) {
			if (properties.has(property)) issues.push(rejected(property, message));
		}
	}
	const pattern = isPattern(record.source);
	if (record.isPattern !== pattern) {
		issues.push(rejected("isPattern", "Redirect pattern flag does not match its source"));
	}
	if (pattern) {
		if (validatePattern(record.source) !== null) {
			issues.push(rejected("source", "Redirect source is not a valid pattern"));
		} else if (
			!isTerminalStatus(record.type) &&
			validateDestinationParams(record.source, record.destination) !== null
		) {
			issues.push(
				rejected(
					"destination",
					"Redirect destination uses a parameter its source does not capture",
				),
			);
		}
	}
	return issues;
}

/** Whether the redirect API would accept this redirect; only these may be compiled. */
export function isImportableRedirect(record: RedirectRecord): boolean {
	return redirectIssues(record).length === 0;
}

const BYLINE_FIELD_VALUE_MESSAGES: Record<BylineFieldType, string> = {
	string: "Byline field value is not a string",
	text: "Byline field value is not a string",
	url: "Byline field value is not an http or https URL",
	boolean: "Byline field value is not a boolean",
	select: "Byline field value is not one of the field's choices",
};

function bylineFieldValueIssues(field: BylineFieldFacts | undefined, value: unknown): ValueIssue[] {
	if (!field) return [];
	try {
		coerceFieldValue(
			{ slug: "", type: field.type, validation: { options: field.options } },
			value ?? null,
		);
		return [];
	} catch (error) {
		if (error instanceof EmDashValidationError) {
			return [rejected("value", BYLINE_FIELD_VALUE_MESSAGES[field.type])];
		}
		throw error;
	}
}

function acceptsUrlPattern(pattern: string): boolean {
	try {
		compileUrlPattern(pattern);
		return true;
	} catch {
		return false;
	}
}

const URL_SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/**
 * The SEO API takes only http(s) canonical URLs, but stored canonicals may
 * also be site paths, which the renderer resolves against the site URL.
 */
function acceptsCanonical(canonical: string): boolean {
	if (URL_SCHEME.test(canonical) || canonical.startsWith("//")) {
		return httpUrl.safeParse(canonical).success;
	}
	return true;
}

export function writeRuleIssues(record: SitePackageRecord, facts: WriteRuleFacts): ValueIssue[] {
	switch (record.kind) {
		case "redirect":
			return redirectIssues(record);
		case "collection":
			return record.urlPattern !== undefined && !acceptsUrlPattern(record.urlPattern)
				? [rejected("urlPattern", "Collection URL pattern is invalid")]
				: [];
		case "byline":
			return record.websiteUrl !== undefined && !httpUrl.safeParse(record.websiteUrl).success
				? [rejected("websiteUrl", "Byline website is not an http or https URL")]
				: [];
		case "byline_field_value":
		case "byline_field_group_value":
			return bylineFieldValueIssues(facts.bylineFields.get(record.fieldId), record.value);
		case "seo":
			return record.seoCanonical !== undefined && !acceptsCanonical(record.seoCanonical)
				? [rejected("seoCanonical", "Canonical URL is not an http or https URL or a site path")]
				: [];
		case "menu_item":
			return record.customUrl !== undefined && !safeHref.safeParse(record.customUrl).success
				? [rejected("customUrl", "Menu item URL uses a scheme menus do not allow")]
				: [];
		default:
			return [];
	}
}
