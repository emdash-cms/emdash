/**
 * Normalized finding contract (plan W8.1, spec §9.6): the canonical shape
 * every analysis stage (deterministic, capability, model, image, history)
 * produces. `validateFinding`/`validateFindings` enforce it against the
 * policy-derived allowed-category set and a run's recorded evidence objects
 * before an assessment finalizes — an invalid finding is a stage-adapter
 * bug, not a retryable condition.
 */

import type { FindingSeverity, PrivateFindingRecord, PublicFindingView } from "./evidence.js";
import { toPublicFinding } from "./evidence.js";
import { automatedBlockCategories, warningCategories, type ModerationPolicy } from "./policy.js";

export type FindingSource = "deterministic" | "capability" | "model" | "image" | "history";

const MAX_TITLE_LENGTH = 512;
const MAX_SUMMARY_LENGTH = 4096;
export const MAX_METADATA_FIELD_LENGTH = 256;
const MAX_ARRAY_ENTRIES = 512;
const MAX_ARRAY_ENTRY_LENGTH = 1024;

export interface ToolFindingMetadata {
	kind: "tool";
	tool: string;
	version: string;
}

export interface ModelFindingMetadata {
	kind: "model";
	modelId: string;
	promptVersion: string;
}

/** Deterministic/capability/history stages report the tool that produced the
 * finding; model/image stages report the model and prompt version. */
export type FindingSourceMetadata = ToolFindingMetadata | ModelFindingMetadata;

/**
 * The category vocabulary a `source: "history"` finding may cite (plan W8.4
 * D4). History findings are context, never labels — the resolver drops them
 * before any category→label mapping — so they cite this dedicated set rather
 * than the policy's automated-block ∪ warning label values, and
 * `validateFinding` holds them to it exclusively.
 */
export type HistoryFindingCategory =
	| "publisher-history"
	| "shared-artifact"
	| "active-manual-label"
	| "publisher-verification";

export const HISTORY_FINDING_CATEGORIES: ReadonlySet<string> = new Set<HistoryFindingCategory>([
	"publisher-history",
	"shared-artifact",
	"active-manual-label",
	"publisher-verification",
]);

export interface NormalizedFinding {
	source: FindingSource;
	/** For non-history sources, a label value from the policy vocabulary —
	 * validated against `allowedFindingCategories` (automated-block ∪ warning),
	 * never the eligibility or manual-system label values. For `source:
	 * "history"`, one of `HISTORY_FINDING_CATEGORIES` instead (plan W8.4 D4). */
	category: string;
	severity: FindingSeverity;
	confidence?: number;
	title: string;
	publicSummary: string;
	privateDetail: string;
	evidenceRefs: readonly string[];
	affectedFiles?: readonly string[];
	affectedImages?: readonly string[];
	sourceMetadata?: FindingSourceMetadata;
}

/**
 * The full set of label values a finding's `category` may cite (spec §9.6's
 * `AllowedFindingCategory`): automated-block ∪ warning, derived from the
 * versioned policy rather than hardcoded so a policy change flows through.
 */
export function allowedFindingCategories(policy: ModerationPolicy): ReadonlySet<string> {
	return new Set([...automatedBlockCategories(policy), ...warningCategories(policy)]);
}

export class FindingValidationError extends Error {
	override readonly name = "FindingValidationError";
}

export interface ValidateFindingOptions {
	allowedCategories: ReadonlySet<string>;
	resolvableEvidenceIds: ReadonlySet<string>;
}

export function validateFinding(finding: unknown, opts: ValidateFindingOptions): NormalizedFinding {
	if (!isRecord(finding)) throw new FindingValidationError("finding must be an object");

	const source = finding.source;
	if (typeof source !== "string" || !isFindingSource(source))
		throw new FindingValidationError(`finding.source is invalid: ${String(source)}`);

	// History findings are exempt from the automated-block ∪ warning constraint
	// (plan W8.4 D4): they cite the dedicated `HISTORY_FINDING_CATEGORIES` set,
	// and only that set — a history finding may not borrow a block/warn label
	// value, nor a non-history finding a history category.
	const allowedCategories =
		source === "history" ? HISTORY_FINDING_CATEGORIES : opts.allowedCategories;
	const category = finding.category;
	if (typeof category !== "string" || !allowedCategories.has(category))
		throw new FindingValidationError(
			`finding.category is not an allowed finding category: ${String(category)}`,
		);

	const severity = finding.severity;
	if (typeof severity !== "string" || !isFindingSeverity(severity))
		throw new FindingValidationError(`finding.severity is invalid: ${String(severity)}`);

	const confidence = finding.confidence;
	if (
		confidence !== undefined &&
		(typeof confidence !== "number" ||
			!Number.isFinite(confidence) ||
			confidence < 0 ||
			confidence > 1)
	)
		throw new FindingValidationError("finding.confidence must be a finite number in [0, 1]");

	const title = requireBoundedString(finding.title, "finding.title", MAX_TITLE_LENGTH);
	const publicSummary = requireBoundedString(
		finding.publicSummary,
		"finding.publicSummary",
		MAX_SUMMARY_LENGTH,
	);
	const privateDetail = requireBoundedString(
		finding.privateDetail,
		"finding.privateDetail",
		MAX_SUMMARY_LENGTH,
	);

	const evidenceRefs = requireStringArray(finding.evidenceRefs, "finding.evidenceRefs");
	for (const ref of evidenceRefs) {
		if (!opts.resolvableEvidenceIds.has(ref))
			throw new FindingValidationError(
				`finding.evidenceRefs references an unresolved evidence object id: ${ref}`,
			);
	}

	const affectedFiles =
		finding.affectedFiles === undefined
			? undefined
			: requireStringArray(finding.affectedFiles, "finding.affectedFiles");
	const affectedImages =
		finding.affectedImages === undefined
			? undefined
			: requireStringArray(finding.affectedImages, "finding.affectedImages");
	const sourceMetadata =
		finding.sourceMetadata === undefined
			? undefined
			: validateSourceMetadata(finding.sourceMetadata);

	return {
		source,
		category,
		severity,
		...(confidence !== undefined ? { confidence } : {}),
		title,
		publicSummary,
		privateDetail,
		evidenceRefs,
		...(affectedFiles !== undefined ? { affectedFiles } : {}),
		...(affectedImages !== undefined ? { affectedImages } : {}),
		...(sourceMetadata !== undefined ? { sourceMetadata } : {}),
	};
}

/** Validates each finding in order, throwing on the first failure with its index. */
export function validateFindings(
	findings: readonly unknown[],
	opts: ValidateFindingOptions,
): NormalizedFinding[] {
	const validated: NormalizedFinding[] = [];
	for (const [index, finding] of findings.entries()) {
		try {
			validated.push(validateFinding(finding, opts));
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			throw new FindingValidationError(`findings[${index}]: ${message}`);
		}
	}
	return validated;
}

/**
 * Projects a validated finding to the public boundary by routing it through
 * `evidence.ts`'s never-typed `PrivateFindingRecord` -> `PublicFindingView`
 * narrowing — this function never constructs a `PublicFindingView` literal
 * itself, so a private field can't leak by drifting out of sync with
 * `toPublicFinding`.
 */
export function toPublicFindingView(
	finding: NormalizedFinding,
	id: string,
	assessmentId: string,
): PublicFindingView {
	const record: PrivateFindingRecord = {
		id,
		assessmentId,
		category: finding.category,
		severity: finding.severity,
		title: finding.title,
		publicSummary: finding.publicSummary,
		privateDetail: finding.privateDetail,
		evidenceRefs: finding.evidenceRefs,
		source: finding.source,
		...(finding.confidence !== undefined ? { confidence: finding.confidence } : {}),
		...(finding.affectedFiles !== undefined ? { affectedFiles: finding.affectedFiles } : {}),
		...(finding.affectedImages !== undefined ? { affectedImages: finding.affectedImages } : {}),
		...(finding.sourceMetadata !== undefined ? { sourceMetadata: finding.sourceMetadata } : {}),
	};
	return toPublicFinding(record);
}

function isFindingSource(value: string): value is FindingSource {
	return (
		value === "deterministic" ||
		value === "capability" ||
		value === "model" ||
		value === "image" ||
		value === "history"
	);
}

function isFindingSeverity(value: string): value is FindingSeverity {
	return (
		value === "critical" ||
		value === "high" ||
		value === "medium" ||
		value === "low" ||
		value === "info"
	);
}

function validateSourceMetadata(value: unknown): FindingSourceMetadata {
	if (!isRecord(value))
		throw new FindingValidationError("finding.sourceMetadata must be an object");
	const kind = value.kind;
	if (kind === "tool") {
		return {
			kind,
			tool: requireBoundedString(
				value.tool,
				"finding.sourceMetadata.tool",
				MAX_METADATA_FIELD_LENGTH,
			),
			version: requireBoundedString(
				value.version,
				"finding.sourceMetadata.version",
				MAX_METADATA_FIELD_LENGTH,
			),
		};
	}
	if (kind === "model") {
		return {
			kind,
			modelId: requireBoundedString(
				value.modelId,
				"finding.sourceMetadata.modelId",
				MAX_METADATA_FIELD_LENGTH,
			),
			promptVersion: requireBoundedString(
				value.promptVersion,
				"finding.sourceMetadata.promptVersion",
				MAX_METADATA_FIELD_LENGTH,
			),
		};
	}
	throw new FindingValidationError(`finding.sourceMetadata.kind is invalid: ${String(kind)}`);
}

function requireBoundedString(value: unknown, field: string, maxLength: number): string {
	if (typeof value !== "string" || value.trim().length === 0)
		throw new FindingValidationError(`${field} must be a non-empty string`);
	if (value.length > maxLength)
		throw new FindingValidationError(`${field} must be at most ${maxLength} characters`);
	return value;
}

function requireStringArray(value: unknown, field: string): readonly string[] {
	if (!Array.isArray(value))
		throw new FindingValidationError(`${field} must be an array of strings`);
	if (value.length > MAX_ARRAY_ENTRIES)
		throw new FindingValidationError(`${field} must have at most ${MAX_ARRAY_ENTRIES} entries`);
	for (const entry of value) {
		if (typeof entry !== "string" || entry.length === 0)
			throw new FindingValidationError(`${field} must be an array of non-empty strings`);
		if (entry.length > MAX_ARRAY_ENTRY_LENGTH)
			throw new FindingValidationError(
				`${field} entries must be at most ${MAX_ARRAY_ENTRY_LENGTH} characters`,
			);
	}
	return [...value];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
