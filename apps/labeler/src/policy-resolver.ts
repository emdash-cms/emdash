/**
 * Versioned policy resolver (plan W8.5, spec §9.9 steps 4–7): pure
 * resolution of a run's validated `NormalizedFinding[]` under a
 * `ModerationPolicy` into a `PolicyOutcome`. No DB, no I/O — the orchestrator
 * (`assessment-orchestrator.ts`) owns everything else in §9.9 (staleness,
 * transient exhaustion, negation, persistence, notification).
 */

import type { FindingSeverity } from "./evidence.js";
import type { NormalizedFinding } from "./findings.js";
import {
	automatedBlockCategories,
	warningCategories,
	type LabelDefinition,
	type ModerationPolicy,
} from "./policy.js";

export interface OutcomeLabel {
	val: string;
	findingCategory?: string;
	severity?: FindingSeverity;
}

export interface PolicyOutcome {
	toState: "passed" | "warned" | "blocked";
	labels: readonly OutcomeLabel[];
}

const SEVERITY_RANK: Record<FindingSeverity, number> = {
	critical: 4,
	high: 3,
	medium: 2,
	low: 1,
	info: 0,
};

function higherSeverity(a: FindingSeverity, b: FindingSeverity): FindingSeverity {
	return SEVERITY_RANK[a] >= SEVERITY_RANK[b] ? a : b;
}

/** A finding's category only maps to a label proposal if that label permits
 * automated issuance on a release subject — a defensive filter on top of
 * W8.1 validation's allowed-category set. */
function permitsAutomatedRelease(definition: LabelDefinition | undefined): boolean {
	if (!definition) return false;
	return definition.subjectRules.some(
		(rule) => rule.subject === "release" && rule.issuanceModes.includes("automated"),
	);
}

/** The automated-block categories that describe image content rather than code
 * behavior (spec §20.2, W8.5 amendment). A sub-threshold finding on one of
 * these degrades to `content-warning`; every other block category degrades to
 * `suspicious-code`. */
const IMAGE_CONTENT_BLOCK_CATEGORIES: ReadonlySet<string> = new Set([
	"hateful-imagery",
	"explicit-imagery",
	"graphic-violence",
]);

/** Warning label a sub-threshold block-category finding degrades to, keyed by
 * the original block category so image-content concerns and code concerns land
 * on honest, distinct warnings. */
function degradedWarningValue(blockCategory: string): string {
	return IMAGE_CONTENT_BLOCK_CATEGORIES.has(blockCategory) ? "content-warning" : "suspicious-code";
}

/** Spec §9.9 steps 4–5 (W8.5 amendment): source/severity rule for whether an
 * automated-block category finding actually blocks. Deterministic/capability
 * findings block at any severity; model/image findings block at `high` or
 * `critical`. `history` never blocks (plan W8.4). A model/image block-category
 * finding below `high` does not block but is never dropped — the caller
 * degrades it to a warning. */
function isBlockingFinding(finding: NormalizedFinding): boolean {
	if (finding.source === "deterministic" || finding.source === "capability") return true;
	if (finding.source === "model" || finding.source === "image")
		return SEVERITY_RANK[finding.severity] >= SEVERITY_RANK.high;
	return false;
}

/** Adds an outcome label, or merges into an existing one with the same `val`
 * (the value issued to the subject) by keeping the higher severity. Provenance
 * (`findingCategory`) is first-citation-wins. */
function addOrMergeLabel(
	labels: OutcomeLabel[],
	index: Map<string, OutcomeLabel>,
	val: string,
	findingCategory: string,
	severity: FindingSeverity,
): void {
	const existing = index.get(val);
	if (existing) {
		existing.severity = higherSeverity(existing.severity ?? severity, severity);
		return;
	}
	const label: OutcomeLabel = { val, findingCategory, severity };
	labels.push(label);
	index.set(val, label);
}

/**
 * Pure resolution per spec §9.9 steps 4–7. Output order is deterministic:
 * blocking labels first, then warnings, then `assessment-passed`, each group
 * in first-citation order (input finding order).
 */
export function resolvePolicyOutcome(
	findings: readonly NormalizedFinding[],
	policy: ModerationPolicy,
): PolicyOutcome {
	const blockCategories = automatedBlockCategories(policy);
	const warnCategories = warningCategories(policy);

	const blockingLabels: OutcomeLabel[] = [];
	const warningLabels: OutcomeLabel[] = [];
	const blockingIndex = new Map<string, OutcomeLabel>();
	const warningIndex = new Map<string, OutcomeLabel>();

	for (const finding of findings) {
		// History may recommend operator review but cannot automatically
		// produce package/publisher labels (plan W8.4) — excluded before any
		// mapping.
		if (finding.source === "history") continue;
		if (!permitsAutomatedRelease(policy.labelsByValue.get(finding.category))) continue;

		if (blockCategories.has(finding.category)) {
			if (isBlockingFinding(finding)) {
				addOrMergeLabel(
					blockingLabels,
					blockingIndex,
					finding.category,
					finding.category,
					finding.severity,
				);
			} else {
				// Sub-threshold model/image block finding: never dropped — degrade to
				// a warning so the concern stays visible, keeping the original block
				// category as the finding association (W8.5 amendment).
				addOrMergeLabel(
					warningLabels,
					warningIndex,
					degradedWarningValue(finding.category),
					finding.category,
					finding.severity,
				);
			}
			continue;
		}
		if (warnCategories.has(finding.category)) {
			addOrMergeLabel(
				warningLabels,
				warningIndex,
				finding.category,
				finding.category,
				finding.severity,
			);
		}
	}

	if (blockingLabels.length > 0) {
		// Step 6 is unconditional: warnings accompany a blocked outcome too.
		return { toState: "blocked", labels: [...blockingLabels, ...warningLabels] };
	}
	if (warningLabels.length > 0) {
		// An assessment may pass and warn at the same time (spec §9.9):
		// `assessment-passed` means no hard-blocking condition.
		return { toState: "warned", labels: [...warningLabels, { val: "assessment-passed" }] };
	}
	return { toState: "passed", labels: [{ val: "assessment-passed" }] };
}
