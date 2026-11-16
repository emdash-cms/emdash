import {
	CODE_FINDING_CATEGORIES,
	FINDING_SEVERITIES,
	isCodeFindingCategory,
	isFindingSeverity,
	type CodeFindingCategory,
	type FindingSeverity,
} from "@emdash-cms/registry-moderation";

export const CODE_RULESET_SCHEMA_VERSION = 1;

const RULE_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const FILE_PATTERN_RE = /^[A-Za-z0-9._*/-]{1,128}$/;
const IDENTIFIER_PATH_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*){0,7}$/;
const REGEX_FLAGS_RE = /^(?!.*(.).*\1)[imsu]*$/;
const MAX_RULES = 256;
const MAX_LIST_ITEMS = 64;
const MAX_PATTERN_LENGTH = 512;
const MAX_SUMMARY_LENGTH = 400;
const MAX_REVIEW_PROMPT_LENGTH = 32_000;
const DEFAULT_AST_FILES = ["*.js"] as const;
const DEFAULT_TEXT_FILES = ["*.js", "manifest.json", "README.md"] as const;
const DEFAULT_REVIEW_FILES = ["*.js", "manifest.json"] as const;

export type AstMatch =
	| { type: "identifier"; names: readonly string[] }
	| { type: "member"; object: string; properties?: readonly string[]; computed: boolean }
	| { type: "call-object-key"; callee: string; keys: readonly string[]; argumentIndex?: number }
	| { type: "import"; modules: readonly string[] };

export type AccessCheck =
	| { type: "host-wildcard" }
	| { type: "host-ip-literal" }
	| { type: "host-pattern"; pattern: string; flags: string }
	| { type: "unrestricted-network" }
	| { type: "declared"; path: readonly string[] };

interface RuleBase {
	id: string;
	category: CodeFindingCategory;
	severity: FindingSeverity;
	confidence: number;
	summary: string;
}

export interface AstRule extends RuleBase {
	kind: "ast";
	files: readonly string[];
	match: AstMatch;
}

export interface TextRule extends RuleBase {
	kind: "text";
	files: readonly string[];
	pattern: string;
	flags: string;
}

export interface AccessRule extends RuleBase {
	kind: "access";
	check: AccessCheck;
}

export interface AccessDiffRule extends RuleBase {
	kind: "access-diff";
	escalationsOnly: boolean;
	paths?: readonly (readonly string[])[];
}

export type CodeRule = AstRule | TextRule | AccessRule | AccessDiffRule;

export interface CodeReviewConfig {
	modelId: string;
	promptVersion: string;
	systemPrompt: string;
	files: readonly string[];
	maxInputCharacters: number;
	maxCompletionTokens: number;
}

export interface CodeRuleset {
	schemaVersion: typeof CODE_RULESET_SCHEMA_VERSION;
	rulesetId: string;
	version: string;
	rules: readonly CodeRule[];
	review?: CodeReviewConfig;
}

export class CodeRulesetError extends TypeError {
	override readonly name = "CodeRulesetError";
}

export function parseCodeRuleset(value: unknown): CodeRuleset {
	const ruleset = exactObject(value, "ruleset", [
		"schemaVersion",
		"rulesetId",
		"version",
		"rules",
		"review",
	]);
	if (ruleset["schemaVersion"] !== CODE_RULESET_SCHEMA_VERSION) {
		throw new CodeRulesetError(`ruleset.schemaVersion must be ${CODE_RULESET_SCHEMA_VERSION}`);
	}
	const rulesValue = ruleset["rules"];
	if (!Array.isArray(rulesValue) || rulesValue.length > MAX_RULES) {
		throw new CodeRulesetError(`ruleset.rules must be an array of at most ${MAX_RULES} rules`);
	}
	const rules = rulesValue.map((rule, index) => parseRule(rule, `ruleset.rules[${index}]`));
	const ids = new Set<string>();
	for (const rule of rules) {
		if (ids.has(rule.id)) throw new CodeRulesetError(`ruleset rule id is duplicated: ${rule.id}`);
		ids.add(rule.id);
	}
	return {
		schemaVersion: CODE_RULESET_SCHEMA_VERSION,
		rulesetId: matching(ruleset["rulesetId"], "ruleset.rulesetId", RULE_ID_RE),
		version: matching(ruleset["version"], "ruleset.version", VERSION_RE),
		rules,
		...(ruleset["review"] === undefined ? {} : { review: parseReview(ruleset["review"]) }),
	};
}

function parseRule(value: unknown, field: string): CodeRule {
	const kind = exactObject(value, field, null)["kind"];
	switch (kind) {
		case "ast": {
			const rule = exactObject(value, field, [...BASE_KEYS, "files", "match"]);
			return {
				...parseBase(rule, field),
				kind,
				files: filePatterns(rule["files"], `${field}.files`, DEFAULT_AST_FILES),
				match: parseAstMatch(rule["match"], `${field}.match`),
			};
		}
		case "text": {
			const rule = exactObject(value, field, [...BASE_KEYS, "files", "pattern", "flags"]);
			const pattern = text(rule["pattern"], `${field}.pattern`, MAX_PATTERN_LENGTH);
			const flags = regexFlags(rule["flags"], `${field}.flags`);
			compileRegex(pattern, flags, `${field}.pattern`);
			return {
				...parseBase(rule, field),
				kind,
				files: filePatterns(rule["files"], `${field}.files`, DEFAULT_TEXT_FILES),
				pattern,
				flags,
			};
		}
		case "access": {
			const rule = exactObject(value, field, [...BASE_KEYS, "check"]);
			return {
				...parseBase(rule, field),
				kind,
				check: parseAccessCheck(rule["check"], `${field}.check`),
			};
		}
		case "access-diff": {
			const rule = exactObject(value, field, [...BASE_KEYS, "escalationsOnly", "paths"]);
			const escalationsOnly = rule["escalationsOnly"] ?? true;
			if (typeof escalationsOnly !== "boolean") {
				throw new CodeRulesetError(`${field}.escalationsOnly must be boolean`);
			}
			const paths =
				rule["paths"] === undefined
					? undefined
					: list(rule["paths"], `${field}.paths`, (item, itemField) => accessPath(item, itemField));
			return {
				...parseBase(rule, field),
				kind,
				escalationsOnly,
				...(paths === undefined ? {} : { paths }),
			};
		}
		default:
			throw new CodeRulesetError(`${field}.kind must be ast, text, access, or access-diff`);
	}
}

const BASE_KEYS = ["kind", "id", "category", "severity", "confidence", "summary"] as const;

function parseBase(rule: Record<string, unknown>, field: string): RuleBase {
	const category = rule["category"];
	if (!isCodeFindingCategory(category)) {
		throw new CodeRulesetError(
			`${field}.category must be one of ${CODE_FINDING_CATEGORIES.join(", ")}`,
		);
	}
	const severity = rule["severity"];
	if (!isFindingSeverity(severity)) {
		throw new CodeRulesetError(`${field}.severity must be one of ${FINDING_SEVERITIES.join(", ")}`);
	}
	const confidence = rule["confidence"];
	if (
		typeof confidence !== "number" ||
		!Number.isFinite(confidence) ||
		confidence < 0 ||
		confidence > 1
	) {
		throw new CodeRulesetError(`${field}.confidence must be between zero and one`);
	}
	return {
		id: matching(rule["id"], `${field}.id`, RULE_ID_RE),
		category,
		severity,
		confidence,
		summary: text(rule["summary"], `${field}.summary`, MAX_SUMMARY_LENGTH),
	};
}

function parseAstMatch(value: unknown, field: string): AstMatch {
	const type = exactObject(value, field, null)["type"];
	switch (type) {
		case "identifier": {
			const match = exactObject(value, field, ["type", "names"]);
			return { type, names: identifiers(match["names"], `${field}.names`) };
		}
		case "member": {
			const match = exactObject(value, field, ["type", "object", "properties", "computed"]);
			const computed = match["computed"] ?? false;
			if (typeof computed !== "boolean") {
				throw new CodeRulesetError(`${field}.computed must be boolean`);
			}
			return {
				type,
				object: matching(match["object"], `${field}.object`, IDENTIFIER_PATH_RE),
				...(match["properties"] === undefined
					? {}
					: { properties: identifiers(match["properties"], `${field}.properties`) }),
				computed,
			};
		}
		case "call-object-key": {
			const match = exactObject(value, field, ["type", "callee", "keys", "argumentIndex"]);
			const argumentIndex = match["argumentIndex"];
			if (
				argumentIndex !== undefined &&
				(typeof argumentIndex !== "number" ||
					!Number.isSafeInteger(argumentIndex) ||
					argumentIndex < 0 ||
					argumentIndex > 16)
			) {
				throw new CodeRulesetError(`${field}.argumentIndex must be an integer from 0 to 16`);
			}
			return {
				type,
				callee: matching(match["callee"], `${field}.callee`, IDENTIFIER_PATH_RE),
				keys: list(match["keys"], `${field}.keys`, (item, itemField) => text(item, itemField, 128)),
				...(argumentIndex === undefined ? {} : { argumentIndex }),
			};
		}
		case "import": {
			const match = exactObject(value, field, ["type", "modules"]);
			return {
				type,
				modules: list(match["modules"], `${field}.modules`, (item, itemField) =>
					text(item, itemField, 214),
				),
			};
		}
		default:
			throw new CodeRulesetError(
				`${field}.type must be identifier, member, call-object-key, or import`,
			);
	}
}

function parseAccessCheck(value: unknown, field: string): AccessCheck {
	const type = exactObject(value, field, null)["type"];
	switch (type) {
		case "host-wildcard":
		case "host-ip-literal":
		case "unrestricted-network":
			exactObject(value, field, ["type"]);
			return { type };
		case "host-pattern": {
			const check = exactObject(value, field, ["type", "pattern", "flags"]);
			const pattern = text(check["pattern"], `${field}.pattern`, MAX_PATTERN_LENGTH);
			const flags = regexFlags(check["flags"], `${field}.flags`);
			compileRegex(pattern, flags, `${field}.pattern`);
			return { type, pattern, flags };
		}
		case "declared": {
			const check = exactObject(value, field, ["type", "path"]);
			return { type, path: accessPath(check["path"], `${field}.path`) };
		}
		default:
			throw new CodeRulesetError(
				`${field}.type must be host-wildcard, host-ip-literal, host-pattern, unrestricted-network, or declared`,
			);
	}
}

function parseReview(value: unknown): CodeReviewConfig {
	const review = exactObject(value, "ruleset.review", [
		"modelId",
		"promptVersion",
		"systemPrompt",
		"files",
		"maxInputCharacters",
		"maxCompletionTokens",
	]);
	return {
		modelId: text(review["modelId"], "ruleset.review.modelId", 256),
		promptVersion: matching(review["promptVersion"], "ruleset.review.promptVersion", VERSION_RE),
		systemPrompt: text(
			review["systemPrompt"],
			"ruleset.review.systemPrompt",
			MAX_REVIEW_PROMPT_LENGTH,
		),
		files: filePatterns(review["files"], "ruleset.review.files", DEFAULT_REVIEW_FILES),
		maxInputCharacters: boundedInteger(
			review["maxInputCharacters"] ?? 200_000,
			"ruleset.review.maxInputCharacters",
			1_000,
			400_000,
		),
		maxCompletionTokens: boundedInteger(
			review["maxCompletionTokens"] ?? 2_048,
			"ruleset.review.maxCompletionTokens",
			256,
			8_192,
		),
	};
}

export function compileRegex(pattern: string, flags: string, field = "pattern"): RegExp {
	try {
		return new RegExp(pattern, `${flags}g`);
	} catch {
		throw new CodeRulesetError(`${field} is not a valid regular expression`);
	}
}

function exactObject(
	value: unknown,
	field: string,
	allowed: readonly string[] | null,
): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new CodeRulesetError(`${field} must be an object`);
	}
	const output: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		if (allowed && !allowed.includes(key)) {
			throw new CodeRulesetError(`${field} contains unsupported field: ${key}`);
		}
		output[key] = Object.getOwnPropertyDescriptor(value, key)?.value;
	}
	return output;
}

function text(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string" || value.length === 0 || value.length > maxLength) {
		throw new CodeRulesetError(
			`${field} must be a non-empty string of at most ${maxLength} characters`,
		);
	}
	return value;
}

function matching(value: unknown, field: string, pattern: RegExp): string {
	const parsed = text(value, field, 256);
	if (!pattern.test(parsed)) throw new CodeRulesetError(`${field} is malformed`);
	return parsed;
}

function list<T>(
	value: unknown,
	field: string,
	parseItem: (item: unknown, itemField: string) => T,
): T[] {
	if (!Array.isArray(value) || value.length === 0 || value.length > MAX_LIST_ITEMS) {
		throw new CodeRulesetError(
			`${field} must be a non-empty array of at most ${MAX_LIST_ITEMS} items`,
		);
	}
	return value.map((item, index) => parseItem(item, `${field}[${index}]`));
}

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;
const ACCESS_SEGMENT_RE = /^[A-Za-z][A-Za-z0-9]*$/;

function identifiers(value: unknown, field: string): string[] {
	return list(value, field, (item, itemField) => matching(item, itemField, IDENTIFIER_RE));
}

function accessPath(value: unknown, field: string): string[] {
	const path = list(value, field, (item, itemField) =>
		matching(item, itemField, ACCESS_SEGMENT_RE),
	);
	if (path.length > 3) throw new CodeRulesetError(`${field} must have at most three segments`);
	return path;
}

function filePatterns(
	value: unknown,
	field: string,
	defaults: readonly string[],
): readonly string[] {
	if (value === undefined) return defaults;
	return list(value, field, (item, itemField) => {
		const pattern = matching(item, itemField, FILE_PATTERN_RE);
		if (
			pattern.split("/").some((segment) => segment === "" || segment === "." || segment === "..")
		) {
			throw new CodeRulesetError(`${itemField} is malformed`);
		}
		return pattern;
	});
}

function regexFlags(value: unknown, field: string): string {
	if (value === undefined) return "";
	if (typeof value !== "string" || !REGEX_FLAGS_RE.test(value)) {
		throw new CodeRulesetError(`${field} may contain only the unique flags i, m, s, and u`);
	}
	return value;
}

function boundedInteger(value: unknown, field: string, minimum: number, maximum: number): number {
	if (
		typeof value !== "number" ||
		!Number.isSafeInteger(value) ||
		value < minimum ||
		value > maximum
	) {
		throw new CodeRulesetError(`${field} must be an integer from ${minimum} to ${maximum}`);
	}
	return value;
}
