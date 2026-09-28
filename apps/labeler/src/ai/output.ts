import {
	isModerationFindingCategory,
	type NormalizedModerationFinding,
} from "@emdash-cms/registry-moderation";

import { ModelOutputError } from "./types.js";

const MAX_FINDINGS = 32;
const MAX_SUMMARY_LENGTH = 500;

export interface ParsedModelOutput {
	findings: readonly NormalizedModerationFinding[];
	coveredEvidenceRefs: readonly string[];
}

export function parseModerationModelOutput(
	json: string,
	allowedEvidenceRefs: readonly string[],
): ParsedModelOutput {
	let value: unknown;
	try {
		value = JSON.parse(json);
	} catch {
		throw new ModelOutputError("invalid-json", "moderation model output is not valid JSON");
	}
	const output = exactRecord(value, "model output", [
		"schemaVersion",
		"findings",
		"coveredEvidenceRefs",
	]);
	if (output["schemaVersion"] !== 1) {
		throw new ModelOutputError("invalid-schema", "model output schemaVersion must be 1");
	}
	if (!Array.isArray(output["findings"]) || output["findings"].length > MAX_FINDINGS) {
		throw new ModelOutputError("invalid-schema", "model output findings are invalid");
	}
	const allowed = new Set(allowedEvidenceRefs);
	if (allowed.size !== allowedEvidenceRefs.length) {
		throw new TypeError("allowed evidence references must be unique");
	}
	const coveredEvidenceRefs = parseEvidenceRefs(
		output["coveredEvidenceRefs"],
		allowed,
		"coveredEvidenceRefs",
	);
	if (
		coveredEvidenceRefs.length !== allowed.size ||
		coveredEvidenceRefs.some((ref) => !allowed.has(ref))
	) {
		throw new ModelOutputError(
			"missing-evidence",
			"model output does not cover every supplied evidence reference",
		);
	}

	const findingKeys = new Set<string>();
	const findings = output["findings"].map((item, index): NormalizedModerationFinding => {
		const finding = exactRecord(item, `findings[${index}]`, [
			"category",
			"confidence",
			"summary",
			"evidenceRefs",
		]);
		if (!isModerationFindingCategory(finding["category"])) {
			throw new ModelOutputError("invalid-schema", `findings[${index}].category is unknown`);
		}
		if (
			typeof finding["confidence"] !== "number" ||
			!Number.isFinite(finding["confidence"]) ||
			finding["confidence"] < 0 ||
			finding["confidence"] > 1
		) {
			throw new ModelOutputError("invalid-schema", `findings[${index}].confidence is invalid`);
		}
		if (
			typeof finding["summary"] !== "string" ||
			finding["summary"].length === 0 ||
			finding["summary"].length > MAX_SUMMARY_LENGTH
		) {
			throw new ModelOutputError("invalid-schema", `findings[${index}].summary is invalid`);
		}
		const evidenceRefs = parseEvidenceRefs(
			finding["evidenceRefs"],
			allowed,
			`findings[${index}].evidenceRefs`,
		);
		if (evidenceRefs.length === 0) {
			throw new ModelOutputError(
				"missing-evidence",
				`findings[${index}] has no supporting evidence`,
			);
		}
		const findingKey = `${finding["category"]}\u0000${evidenceRefs.toSorted().join("\u0000")}`;
		if (findingKeys.has(findingKey)) {
			throw new ModelOutputError(
				"contradictory-output",
				"model output repeats a category for the same evidence",
			);
		}
		findingKeys.add(findingKey);
		return {
			category: finding["category"],
			recommendation: "review",
			confidence: finding["confidence"],
			summary: finding["summary"],
			evidenceRefs,
		};
	});
	return { findings, coveredEvidenceRefs };
}

function parseEvidenceRefs(value: unknown, allowed: ReadonlySet<string>, field: string): string[] {
	if (!Array.isArray(value) || value.length > 256) {
		throw new ModelOutputError("invalid-schema", `${field} must be a bounded array`);
	}
	const refs = value.map((ref, index) => {
		if (typeof ref !== "string" || ref.length === 0 || ref.length > 512) {
			throw new ModelOutputError("invalid-schema", `${field}[${index}] is invalid`);
		}
		if (!allowed.has(ref)) {
			throw new ModelOutputError("unknown-evidence", `${field}[${index}] was not supplied`);
		}
		return ref;
	});
	if (new Set(refs).size !== refs.length) {
		throw new ModelOutputError("contradictory-output", `${field} contains duplicate references`);
	}
	return refs;
}

function exactRecord(
	value: unknown,
	field: string,
	keys: readonly string[],
): Record<string, unknown> {
	if (!isObject(value)) {
		throw new ModelOutputError("invalid-schema", `${field} must be an object`);
	}
	const record = value;
	if (Object.keys(record).some((key) => !keys.includes(key))) {
		throw new ModelOutputError("invalid-schema", `${field} contains an unknown field`);
	}
	if (keys.some((key) => !(key in record))) {
		throw new ModelOutputError("invalid-schema", `${field} is missing a required field`);
	}
	return record;
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
