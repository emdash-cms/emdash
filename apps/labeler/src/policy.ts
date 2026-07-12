import moderationPolicyFixture from "../fixtures/moderation-policy.json";

export type IssuanceMode = "automated" | "reviewer" | "admin";
export type SubjectKind = "release" | "package" | "publisher";
export type CidRule = "required" | "forbidden" | "optional";
export type LabelCategory = "eligibility" | "automated-block" | "warning" | "manual-system";

export interface SubjectRule {
	subject: SubjectKind;
	cidRule: CidRule;
	issuanceModes: readonly IssuanceMode[];
}

export interface LabelDefinition {
	value: string;
	category: LabelCategory;
	officialEffect: string;
	subjectRules: readonly SubjectRule[];
}

export interface ModerationPolicy {
	policyVersion: string;
	labelerDid: string;
	labels: readonly LabelDefinition[];
	labelsByValue: ReadonlyMap<string, LabelDefinition>;
}

function isIssuanceMode(value: string): value is IssuanceMode {
	return value === "automated" || value === "reviewer" || value === "admin";
}

function isSubjectKind(value: string): value is SubjectKind {
	return value === "release" || value === "package" || value === "publisher";
}

function isCidRule(value: string): value is CidRule {
	return value === "required" || value === "forbidden" || value === "optional";
}

function isLabelCategory(value: string): value is LabelCategory {
	return (
		value === "eligibility" ||
		value === "automated-block" ||
		value === "warning" ||
		value === "manual-system"
	);
}

/**
 * Automated-block finding categories: the label vocabulary this policy
 * treats as security/impersonation blocking conditions. A finding must cite
 * one of these to justify an automated blocking label (spec §20.2).
 */
export function automatedBlockCategories(policy: ModerationPolicy): ReadonlySet<string> {
	const categories = new Set<string>();
	for (const label of policy.labels) {
		if (label.category === "automated-block") categories.add(label.value);
	}
	return categories;
}

export function parseModerationPolicy(value: unknown): ModerationPolicy {
	if (!isRecord(value)) throw new TypeError("moderation policy must be an object");
	if (typeof value.policyVersion !== "string" || value.policyVersion.length === 0)
		throw new TypeError("moderation policy policyVersion must be a non-empty string");
	if (typeof value.labelerDid !== "string" || value.labelerDid.length === 0)
		throw new TypeError("moderation policy labelerDid must be a non-empty string");
	if (!Array.isArray(value.labels) || value.labels.length === 0)
		throw new TypeError("moderation policy labels must be a non-empty array");

	const labels: LabelDefinition[] = [];
	const labelsByValue = new Map<string, LabelDefinition>();
	for (const [index, entry] of value.labels.entries()) {
		const definition = parseLabelDefinition(entry, index);
		if (labelsByValue.has(definition.value))
			throw new TypeError(
				`moderation policy labels[${index}] duplicates value "${definition.value}"`,
			);
		labels.push(definition);
		labelsByValue.set(definition.value, definition);
	}

	return {
		policyVersion: value.policyVersion,
		labelerDid: value.labelerDid,
		labels,
		labelsByValue,
	};
}

function parseLabelDefinition(entry: unknown, index: number): LabelDefinition {
	if (!isRecord(entry)) throw new TypeError(`moderation policy labels[${index}] must be an object`);
	const value = entry.value;
	if (typeof value !== "string" || value.length === 0)
		throw new TypeError(`moderation policy labels[${index}].value must be a non-empty string`);
	const category = entry.category;
	if (typeof category !== "string" || !isLabelCategory(category))
		throw new TypeError(`moderation policy labels[${index}].category is invalid`);
	const officialEffect = entry.officialEffect;
	if (typeof officialEffect !== "string" || officialEffect.length === 0)
		throw new TypeError(
			`moderation policy labels[${index}].officialEffect must be a non-empty string`,
		);
	if (!Array.isArray(entry.subjectRules) || entry.subjectRules.length === 0)
		throw new TypeError(
			`moderation policy labels[${index}].subjectRules must be a non-empty array`,
		);

	const subjectRules = entry.subjectRules.map((rule, ruleIndex) =>
		parseSubjectRule(rule, index, ruleIndex),
	);

	return { value, category, officialEffect, subjectRules };
}

function parseSubjectRule(rule: unknown, labelIndex: number, ruleIndex: number): SubjectRule {
	const path = `moderation policy labels[${labelIndex}].subjectRules[${ruleIndex}]`;
	if (!isRecord(rule)) throw new TypeError(`${path} must be an object`);
	const subject = rule.subject;
	if (typeof subject !== "string" || !isSubjectKind(subject))
		throw new TypeError(`${path}.subject is invalid`);
	const cidRule = rule.cidRule;
	if (typeof cidRule !== "string" || !isCidRule(cidRule))
		throw new TypeError(`${path}.cidRule is invalid`);
	const issuanceModes = rule.issuanceModes;
	if (!Array.isArray(issuanceModes) || issuanceModes.length === 0)
		throw new TypeError(`${path}.issuanceModes must be a non-empty array of valid modes`);
	if (
		!issuanceModes.every(
			(mode): mode is IssuanceMode => typeof mode === "string" && isIssuanceMode(mode),
		)
	)
		throw new TypeError(`${path}.issuanceModes must be a non-empty array of valid modes`);

	return { subject, cidRule, issuanceModes };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export const MODERATION_POLICY: ModerationPolicy = parseModerationPolicy(moderationPolicyFixture);

export function getLabelDefinition(value: string): LabelDefinition | undefined {
	return MODERATION_POLICY.labelsByValue.get(value);
}
