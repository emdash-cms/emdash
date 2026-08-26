import { LISTING_LABELS, type ListingLabelValue } from "./labels.js";
import { record, runtimeSchema, stringArray, stringValue } from "./schema.js";
import { assertDid, parseInstant } from "./validation.js";

export interface ListingModerationPolicy {
	schemaVersion: 1;
	policyVersion: string;
	effectiveAt: string;
	requiredPositiveSources: readonly string[];
	acceptedStateSources: readonly string[];
	redactionSources: readonly string[];
	autoPass: "disabled" | "assisted";
	prohibitedCategories: readonly ModerationFindingCategory[];
}

export const MODERATION_FINDING_CATEGORIES = [
	"explicit-sexual-content",
	"hateful-or-dehumanizing-content",
	"graphic-violence",
	"phishing-or-credential-solicitation",
	"material-impersonation",
	"scam-or-spam",
	"malicious-or-deceptive-link",
	"misleading-media-or-claims",
] as const;

export type ModerationFindingCategory = (typeof MODERATION_FINDING_CATEGORIES)[number];

export function isModerationFindingCategory(value: unknown): value is ModerationFindingCategory {
	return MODERATION_FINDING_CATEGORIES.some((category) => category === value);
}

export const STATE_LABEL_VALUES: readonly ListingLabelValue[] = [
	LISTING_LABELS.passed,
	LISTING_LABELS.pending,
	LISTING_LABELS.review,
	LISTING_LABELS.error,
	LISTING_LABELS.blocked,
	LISTING_LABELS.overridden,
];

export function stateSources(policy: ListingModerationPolicy): ReadonlySet<string> {
	return new Set([...policy.requiredPositiveSources, ...policy.acceptedStateSources]);
}

export function assertListingModerationPolicy(value: ListingModerationPolicy): void {
	if (value.schemaVersion !== 1) throw new TypeError("policy.schemaVersion must be 1");
	if (!value.policyVersion) throw new TypeError("policy.policyVersion must not be empty");
	parseInstant(value.effectiveAt, "policy.effectiveAt");
	for (const [field, sources] of [
		["requiredPositiveSources", value.requiredPositiveSources],
		["acceptedStateSources", value.acceptedStateSources],
		["redactionSources", value.redactionSources],
	] as const) {
		if (new Set(sources).size !== sources.length) {
			throw new TypeError(`policy.${field} must not contain duplicate sources`);
		}
		for (const source of sources) assertDid(source, `policy.${field}`);
	}
	if (value.requiredPositiveSources.length === 0) {
		throw new TypeError("policy.requiredPositiveSources must not be empty");
	}
	if (value.autoPass !== "disabled" && value.autoPass !== "assisted") {
		throw new TypeError("policy.autoPass must be disabled or assisted");
	}
	if (new Set(value.prohibitedCategories).size !== value.prohibitedCategories.length) {
		throw new TypeError("policy.prohibitedCategories must not contain duplicates");
	}
	for (const category of value.prohibitedCategories) {
		if (!(MODERATION_FINDING_CATEGORIES as readonly string[]).includes(category)) {
			throw new TypeError(`policy contains unknown category: ${category}`);
		}
	}
}

function parsePolicy(value: unknown): ListingModerationPolicy {
	const policy = record(value, "policy", [
		"schemaVersion",
		"policyVersion",
		"effectiveAt",
		"requiredPositiveSources",
		"acceptedStateSources",
		"redactionSources",
		"autoPass",
		"prohibitedCategories",
	]);
	const autoPass = policy["autoPass"];
	if (autoPass !== "disabled" && autoPass !== "assisted") {
		throw new TypeError("policy.autoPass must be disabled or assisted");
	}
	if (policy["schemaVersion"] !== 1) throw new TypeError("policy.schemaVersion must be 1");
	const prohibitedValues = stringArray(
		policy["prohibitedCategories"],
		"policy.prohibitedCategories",
		MODERATION_FINDING_CATEGORIES.length,
	);
	const prohibitedCategories: ModerationFindingCategory[] = [];
	for (const category of prohibitedValues) {
		if (!isModerationFindingCategory(category)) {
			throw new TypeError(`policy contains unknown category: ${category}`);
		}
		prohibitedCategories.push(category);
	}
	const parsed: ListingModerationPolicy = {
		schemaVersion: 1,
		policyVersion: stringValue(policy["policyVersion"], "policy.policyVersion", 128),
		effectiveAt: stringValue(policy["effectiveAt"], "policy.effectiveAt", 64),
		requiredPositiveSources: stringArray(
			policy["requiredPositiveSources"],
			"policy.requiredPositiveSources",
			16,
		),
		acceptedStateSources: stringArray(
			policy["acceptedStateSources"],
			"policy.acceptedStateSources",
			16,
		),
		redactionSources: stringArray(policy["redactionSources"], "policy.redactionSources", 16),
		autoPass,
		prohibitedCategories,
	};
	assertListingModerationPolicy(parsed);
	return parsed;
}

export const ListingModerationPolicySchema = runtimeSchema(parsePolicy);
