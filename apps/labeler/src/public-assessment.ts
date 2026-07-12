/**
 * Public assessment serializer boundary (W10, contracts `publicAssessment`).
 *
 * The stored `Assessment` row carries internal fields the public API must
 * never leak (trigger, triggerId, runKey, promptHash's raw provenance).
 * `toPublicAssessment` is the only constructor of `PublicAssessmentView` —
 * mirrors evidence.ts's private/public finding boundary, but here the
 * boundary falls out of the two shapes simply not overlapping (the view has
 * no structural path back to a raw row) rather than a `never`-typed trick.
 */

import type { LabelerDefs } from "@emdash-cms/registry-lexicons";

import moderationPolicy from "../fixtures/moderation-policy.json";
import type { AssessmentState, PublicAssessmentState } from "./assessment-lifecycle.js";
import type { Assessment } from "./assessment-store.js";

export type PublicAssessmentView = LabelerDefs.PublicAssessment;

export interface PublicLabelSummary {
	val: string;
	active: boolean;
	issuedAt: string;
	expiresAt?: string;
}

const ASSESSMENT_SCHEMA_VERSION = moderationPolicy.assessmentSchemaVersion;

const FALLBACK_SUMMARY: Readonly<Record<PublicAssessmentState, string>> = {
	pending: "Assessment pending.",
	passed: "Assessment passed.",
	warned: "Assessment completed with warnings.",
	blocked: "Assessment blocked.",
	error: "Assessment failed to complete.",
	superseded: "Assessment superseded by a newer run.",
};

/**
 * Public state derivation (spec §718, contracts `publicAssessment`).
 * `observed`/`verifying` are pre-decision internal states; `stale` and
 * `cancelled` ended inconclusively and never own the pointer — none of the
 * four are public. `isSuperseded` must come from the back-pointer +
 * pointer-ownership rule (`isSuperseded` in assessment-store.ts): a row is
 * never superseded merely for not being the current pointer.
 */
export function derivePublicState(
	state: AssessmentState,
	isSuperseded: boolean,
): PublicAssessmentState | null {
	switch (state) {
		case "observed":
		case "verifying":
		case "stale":
		case "cancelled":
			return null;
		case "running":
		case "pending":
			return "pending";
		case "passed":
			return isSuperseded ? "superseded" : "passed";
		case "warned":
			return isSuperseded ? "superseded" : "warned";
		case "blocked":
			return isSuperseded ? "superseded" : "blocked";
		case "error":
			return isSuperseded ? "superseded" : "error";
	}
}

interface Coverage {
	code: string;
	images: string;
	metadata: string;
}

const COVERAGE_VALUES: ReadonlySet<string> = new Set(["complete", "partial", "unavailable"]);
const IMAGE_COVERAGE_VALUES: ReadonlySet<string> = new Set([
	"complete",
	"partial",
	"unavailable",
	"not-present",
]);
const UNAVAILABLE_COVERAGE: Coverage = {
	code: "unavailable",
	images: "unavailable",
	metadata: "unavailable",
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** Never throws on a malformed stored blob — falls back to all-`unavailable`
 * and logs, since a bad `coverage_json` row must not 500 the public API. */
function parseCoverage(assessmentId: string, json: string): Coverage {
	try {
		const parsed: unknown = JSON.parse(json);
		if (
			isRecord(parsed) &&
			typeof parsed.code === "string" &&
			COVERAGE_VALUES.has(parsed.code) &&
			typeof parsed.images === "string" &&
			IMAGE_COVERAGE_VALUES.has(parsed.images) &&
			typeof parsed.metadata === "string" &&
			COVERAGE_VALUES.has(parsed.metadata)
		) {
			return {
				code: parsed.code,
				images: parsed.images,
				metadata: parsed.metadata,
			};
		}
	} catch {
		// falls through to the unavailable default below
	}
	console.error(`[public-assessment] malformed coverage_json on assessment ${assessmentId}`);
	return UNAVAILABLE_COVERAGE;
}

export interface ToPublicAssessmentOptions {
	labelerDid: string;
	publicState: PublicAssessmentState;
	labels: readonly PublicLabelSummary[];
	reconsiderationUrl: string;
}

/**
 * The only constructor of a `publicAssessment` view. Internal-only stored
 * fields (trigger, triggerId, runKey, the raw prompt hash's provenance)
 * never reach the output — there is no structural path from `Assessment` to
 * `PublicAssessmentView` other than through this function.
 */
export function toPublicAssessment(
	row: Assessment,
	opts: ToPublicAssessmentOptions,
): PublicAssessmentView {
	const model =
		row.modelId !== null && row.promptHash !== null
			? { provider: "workers-ai", modelId: row.modelId, promptVersion: row.promptHash }
			: undefined;
	if (row.modelId !== null && row.promptHash === null) {
		console.error(`[public-assessment] assessment ${row.id} has modelId without promptHash`);
	}
	return {
		id: row.id,
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- labelerDid is validated at config load (config.ts)
		src: opts.labelerDid as `did:${string}:${string}`,
		subject: {
			// eslint-disable-next-line typescript/no-unsafe-type-assertion -- uri is a stored, already-verified AT-URI (assessments only exist for verified subjects)
			uri: row.uri as PublicAssessmentView["subject"]["uri"],
			cid: row.cid,
		},
		...(row.artifactChecksum !== null
			? {
					artifact: {
						...(row.artifactId !== null ? { id: row.artifactId } : {}),
						checksum: row.artifactChecksum,
					},
				}
			: {}),
		state: opts.publicState,
		summary:
			row.publicSummary !== null && row.publicSummary.length > 0
				? row.publicSummary
				: FALLBACK_SUMMARY[opts.publicState],
		coverage: parseCoverage(row.id, row.coverageJson),
		labels: [...opts.labels],
		policyVersion: row.policyVersion,
		assessmentSchemaVersion: ASSESSMENT_SCHEMA_VERSION,
		...(model !== undefined ? { model } : {}),
		createdAt: row.createdAt,
		...(row.completedAt !== null ? { completedAt: row.completedAt } : {}),
		...(row.supersedesAssessmentId !== null
			? { supersedesAssessmentId: row.supersedesAssessmentId }
			: {}),
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- sourced from the ratified policy fixture's contact.reconsiderationUrl
		reconsiderationUrl: opts.reconsiderationUrl as PublicAssessmentView["reconsiderationUrl"],
	};
}
