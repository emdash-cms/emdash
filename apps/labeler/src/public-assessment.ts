import { is } from "@atcute/lexicons/validations";
import {
	LabelerGetAssessment,
	LabelerGetCurrentAssessment,
	LabelerGetPolicy,
	LabelerListAssessments,
	NSID,
} from "@emdash-cms/registry-lexicons";
import {
	createListingLabelSigner,
	subjectKindFromUri,
	type ListingLabelSigner,
} from "@emdash-cms/registry-moderation";
import { INITIAL_LISTING_POLICY_FIXTURE } from "@emdash-cms/registry-moderation/fixtures";

import { readLabelerRuntimeConfig, readPublicLabelerRuntimeConfig } from "./runtime-config.js";

const GET_ASSESSMENT_PATH = `/xrpc/${NSID.labelerGetAssessment}`;
const GET_CURRENT_ASSESSMENT_PATH = `/xrpc/${NSID.labelerGetCurrentAssessment}`;
const LIST_ASSESSMENTS_PATH = `/xrpc/${NSID.labelerListAssessments}`;
const GET_POLICY_PATH = `/xrpc/${NSID.labelerGetPolicy}`;
const ASSESSMENT_PATHS = new Set([
	GET_ASSESSMENT_PATH,
	GET_CURRENT_ASSESSMENT_PATH,
	LIST_ASSESSMENTS_PATH,
	GET_POLICY_PATH,
]);

const ASSESSMENT_SCHEMA_VERSION = 1;
const PUBLIC_POLICY_VERSION = INITIAL_LISTING_POLICY_FIXTURE.policyVersion;
const PROVIDER_CATALOG_MODEL_VERSION = "provider-catalog-id";
const DEFAULT_LIST_LIMIT = 50;
const MAX_LIST_LIMIT = 100;
const MAX_CURSOR_LENGTH = 1_024;
const MAX_FINDINGS = 32;
const MAX_LABELS = 16;
const PUBLIC_REASON_CODE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const POSITIVE_INTEGER_RE = /^[1-9]\d{0,2}$/;
const BASE64URL_RE = /^[A-Za-z0-9_-]+$/;
const BASE64_PADDING_RE = /=+$/u;
const PUBLIC_RUN_STATE_SQL = `CASE assessment.state
	WHEN 'running' THEN 'pending'
	WHEN 'cancelled' THEN 'superseded'
	ELSE assessment.state
END`;

type PublicAssessmentState = "pending" | "passed" | "review" | "blocked" | "error" | "superseded";

type SubjectKind = "profile" | "release";

interface AssessmentRow {
	id: string;
	subject_uri: string;
	subject_cid: string;
	subject_kind: SubjectKind;
	policy_version: string;
	parser_version: string;
	text_model_id: string;
	text_prompt_hash: string;
	image_model_id: string;
	image_prompt_hash: string;
	state: string;
	public_run_state: string;
	coverage_json: string | null;
	summary_json: string | null;
	error_code: string | null;
	created_at: string;
	completed_at: string | null;
	manual_action: "approve" | "block" | null;
	manual_decided_at: string | null;
	superseded_by_assessment_id: string | null;
}

interface FindingRow {
	assessment_id: string;
	category: string;
	reason_code: string;
	position: number;
}

interface LabelRow {
	assessment_id: string | null;
	sequence: number;
	ver: number;
	src: string;
	uri: string;
	cid: string | null;
	val: string;
	neg: number;
	cts: string;
	exp: string | null;
	sig: ArrayBuffer | Uint8Array;
	position?: number;
}

interface AssessmentSupplements {
	findings: ReadonlyMap<string, readonly FindingRow[]>;
	labels: ReadonlyMap<string, readonly LabelRow[]>;
}

interface ListFilters {
	kind?: SubjectKind;
	uri?: string;
	cid?: string;
	state?: PublicAssessmentState;
}

interface ListCursor {
	v: 1;
	createdAt: string;
	id: string;
	filters: string;
}

interface PublicAssessmentStatement {
	bind(...values: unknown[]): PublicAssessmentStatement;
	first<Row = Record<string, unknown>>(): Promise<Row | null>;
	all<Row = Record<string, unknown>>(): Promise<{ results?: Row[] }>;
}

interface PublicAssessmentDatabase {
	prepare(query: string): PublicAssessmentStatement;
}

class PublicLabelConflictError extends Error {
	override readonly name = "PublicLabelConflictError";
}

type PublicAssessmentConfigKey =
	| "LABELER_DID"
	| "LABELER_SERVICE_URL"
	| "LABEL_SIGNING_PRIVATE_KEY"
	| "LABEL_SIGNING_PUBLIC_KEY"
	| "LABELER_POLICY_VERSION"
	| "LABELER_PARSER_VERSION"
	| "LABELER_TEXT_MODEL_ID"
	| "LABELER_IMAGE_MODEL_ID";

type PublicAssessmentEnv = Record<PublicAssessmentConfigKey, string> & {
	DB: PublicAssessmentDatabase;
};

/**
 * Handles the four experimental public assessment XRPC queries. A null result
 * means the request path belongs to another part of the Worker.
 */
export async function handlePublicAssessmentXrpc(
	request: Request,
	env: PublicAssessmentEnv,
	now = new Date(),
): Promise<Response | null> {
	const url = new URL(request.url);
	if (!ASSESSMENT_PATHS.has(url.pathname)) return null;
	if (request.method !== "GET") {
		return xrpcError("MethodNotSupported", "This XRPC query only supports GET", 405, {
			allow: "GET",
		});
	}

	try {
		const config = readPublicLabelerRuntimeConfig(env);
		if (config.versions.policyVersion !== PUBLIC_POLICY_VERSION) {
			throw new TypeError("configured assessment policy has no public policy definition");
		}
		if (url.pathname === GET_POLICY_PATH) return getPolicy(env, url.searchParams);
		const signer = await createPublicAssessmentSigner(env);
		if (url.pathname === GET_ASSESSMENT_PATH) {
			return await getAssessment(env.DB, config.labelerDid, signer, url.searchParams);
		}
		if (url.pathname === GET_CURRENT_ASSESSMENT_PATH) {
			return await getCurrentAssessment(env.DB, config.labelerDid, signer, url.searchParams, now);
		}
		return await listAssessments(env.DB, config.labelerDid, signer, url.searchParams);
	} catch (error) {
		if (error instanceof PublicLabelConflictError) {
			return xrpcError("ConflictingLabels", "The current signed label state is conflicting", 409);
		}
		return xrpcError(
			"InternalServerError",
			"The public assessment service could not complete the request",
			500,
		);
	}
}

async function getAssessment(
	db: PublicAssessmentDatabase,
	labelerDid: string,
	signer: ListingLabelSigner,
	params: URLSearchParams,
): Promise<Response> {
	if (!hasOnlySingleParams(params, ["id"])) return invalidRequest("Assessment ID is invalid");
	const id = params.get("id");
	if (!id || !is(LabelerGetAssessment.mainSchema.params, { id })) {
		return invalidRequest("Assessment ID is invalid");
	}
	const row = await readAssessmentById(db, id);
	if (!row) return xrpcError("NotFound", "Assessment was not found", 404);
	const supplements = await readAssessmentSupplements(db, [row.id]);
	const output = await publicAssessment(row, labelerDid, signer, supplements);
	assertLexiconOutput(LabelerGetAssessment.mainSchema.output.schema, output);
	return jsonResponse(output);
}

async function getCurrentAssessment(
	db: PublicAssessmentDatabase,
	labelerDid: string,
	signer: ListingLabelSigner,
	params: URLSearchParams,
	now: Date,
): Promise<Response> {
	if (!hasOnlySingleParams(params, ["kind", "uri", "cid"])) {
		return invalidRequest("Assessment subject is invalid");
	}
	const input = {
		kind: params.get("kind") ?? "",
		uri: params.get("uri") ?? "",
		cid: params.get("cid") ?? "",
	};
	if (
		!is(LabelerGetCurrentAssessment.mainSchema.params, input) ||
		subjectKindFromUri(input.uri) !== input.kind
	) {
		return invalidRequest("Assessment subject is invalid");
	}
	const row = await readCurrentAssessment(db, input.kind, input.uri, input.cid);
	if (!row) return xrpcError("NotFound", "Current assessment was not found", 404);
	const [supplements, activeLabels] = await Promise.all([
		readAssessmentSupplements(db, [row.id]),
		readActiveLabels(db, labelerDid, input.uri, input.cid, now),
	]);
	const output = {
		src: labelerDid,
		subject: { kind: input.kind, uri: input.uri, cid: input.cid },
		assessment: await publicAssessment(row, labelerDid, signer, supplements),
		activeLabels: await Promise.all(activeLabels.map((label) => publicLabel(label, signer))),
	};
	assertLexiconOutput(LabelerGetCurrentAssessment.mainSchema.output.schema, output);
	return jsonResponse(output);
}

async function listAssessments(
	db: PublicAssessmentDatabase,
	labelerDid: string,
	signer: ListingLabelSigner,
	params: URLSearchParams,
): Promise<Response> {
	const allowedParams = ["kind", "uri", "cid", "state", "limit", "cursor"];
	if (!hasOnlySingleParams(params, allowedParams, true)) {
		return invalidRequest("Assessment filters are invalid");
	}
	const limit = parseLimit(params.get("limit"));
	if (limit === null) return invalidRequest("Assessment limit is invalid");
	const filters = parseListFilters(params);
	if (!filters) return invalidRequest("Assessment filters are invalid");
	const cursorValue = params.get("cursor");
	const cursor = cursorValue === null ? undefined : decodeCursor(cursorValue, filters);
	if (cursorValue !== null && !cursor) {
		return xrpcError("InvalidCursor", "Assessment cursor is invalid", 400);
	}

	const rows = await readAssessmentPage(db, filters, cursor ?? undefined, limit + 1);
	const page = rows.slice(0, limit);
	const supplements = await readAssessmentSupplements(
		db,
		page.map(({ id }) => id),
	);
	const last = page.at(-1);
	const output = {
		assessments: await Promise.all(
			page.map((row) => publicAssessment(row, labelerDid, signer, supplements)),
		),
		...(rows.length > limit && last
			? { cursor: encodeCursor(last.created_at, last.id, filters) }
			: {}),
	};
	assertLexiconOutput(LabelerListAssessments.mainSchema.output.schema, output);
	return jsonResponse(output);
}

async function createPublicAssessmentSigner(env: PublicAssessmentEnv): Promise<ListingLabelSigner> {
	const config = await readLabelerRuntimeConfig(env);
	return createListingLabelSigner({
		issuerDid: config.labelerDid,
		privateKey: config.privateKey,
		resolveDid: async () => ({
			id: config.labelerDid,
			verificationMethod: [
				{
					id: `${config.labelerDid}#atproto_label`,
					type: "Multikey",
					controller: config.labelerDid,
					publicKeyMultibase: config.publicKeyMultibase,
				},
			],
		}),
	});
}

function getPolicy(env: PublicAssessmentEnv, params: URLSearchParams): Response {
	if ([...params.keys()].length !== 0) return invalidRequest("Policy query has no parameters");
	const config = readPublicLabelerRuntimeConfig(env);
	const output = {
		schemaVersion: 1,
		policyVersion: config.versions.policyVersion,
		effectiveAt: INITIAL_LISTING_POLICY_FIXTURE.effectiveAt,
		labelerDid: config.labelerDid,
		assessmentSchemaVersion: ASSESSMENT_SCHEMA_VERSION,
		parserVersion: config.versions.parserVersion,
		supportedSubjects: [
			{ kind: "profile", collection: NSID.packageProfile },
			{ kind: "release", collection: NSID.packageRelease },
		],
		reasonCodes: PUBLIC_REASON_CODES,
		labels: PUBLIC_LABEL_DEFINITIONS,
		models: [
			modelDescriptor("text", config.versions.textModelId, config.versions.textPromptHash),
			modelDescriptor("image", config.versions.imageModelId, config.versions.imagePromptHash),
		],
		publicApi: {
			baseUrl: `${config.serviceUrl}/xrpc/`,
			getAssessmentNsid: NSID.labelerGetAssessment,
			getCurrentAssessmentNsid: NSID.labelerGetCurrentAssessment,
			listAssessmentsNsid: NSID.labelerListAssessments,
			getPolicyNsid: NSID.labelerGetPolicy,
		},
	};
	assertLexiconOutput(LabelerGetPolicy.mainSchema.output.schema, output);
	return jsonResponse(output);
}

const ASSESSMENT_SELECT = `SELECT
	assessment.id,
	assessment.subject_uri,
	assessment.subject_cid,
	assessment.subject_kind,
	assessment.policy_version,
	assessment.parser_version,
	assessment.text_model_id,
	assessment.text_prompt_hash,
	assessment.image_model_id,
	assessment.image_prompt_hash,
	assessment.state,
		${PUBLIC_RUN_STATE_SQL} AS public_run_state,
	assessment.coverage_json,
	assessment.summary_json,
	assessment.error_code,
	assessment.created_at,
	assessment.completed_at,
	decision.action AS manual_action,
	decision.created_at AS manual_decided_at,
	CASE
		WHEN current.assessment_id IS NOT NULL AND current.assessment_id <> assessment.id
		THEN current.assessment_id
		ELSE NULL
	END AS superseded_by_assessment_id
FROM assessments assessment
LEFT JOIN operator_actions decision ON decision.id = (
	SELECT candidate.id
	FROM operator_actions candidate
	WHERE candidate.subject_uri = assessment.subject_uri
		AND candidate.subject_cid = assessment.subject_cid
		AND candidate.action IN ('approve', 'block')
	ORDER BY candidate.created_at DESC, candidate.id DESC
	LIMIT 1
)
LEFT JOIN current_assessments current
	ON current.subject_uri = assessment.subject_uri
	AND current.subject_cid = assessment.subject_cid`;

async function readAssessmentById(
	db: PublicAssessmentDatabase,
	id: string,
): Promise<AssessmentRow | null> {
	return db.prepare(`${ASSESSMENT_SELECT} WHERE assessment.id = ?`).bind(id).first<AssessmentRow>();
}

async function readCurrentAssessment(
	db: PublicAssessmentDatabase,
	kind: string,
	uri: string,
	cid: string,
): Promise<AssessmentRow | null> {
	return db
		.prepare(
			`${ASSESSMENT_SELECT}
			 WHERE assessment.id = current.assessment_id
				AND assessment.subject_kind = ?
				AND assessment.subject_uri = ?
				AND assessment.subject_cid = ?`,
		)
		.bind(kind, uri, cid)
		.first<AssessmentRow>();
}

async function readAssessmentPage(
	db: PublicAssessmentDatabase,
	filters: ListFilters,
	cursor: ListCursor | undefined,
	queryLimit: number,
): Promise<AssessmentRow[]> {
	const clauses: string[] = [];
	const bindings: unknown[] = [];
	if (filters.kind) {
		clauses.push("assessment.subject_kind = ?");
		bindings.push(filters.kind);
	}
	if (filters.uri) {
		clauses.push("assessment.subject_uri = ?");
		bindings.push(filters.uri);
	}
	if (filters.cid) {
		clauses.push("assessment.subject_cid = ?");
		bindings.push(filters.cid);
	}
	if (filters.state) {
		clauses.push(`${PUBLIC_RUN_STATE_SQL} = ?`);
		bindings.push(filters.state);
	}
	if (cursor) {
		clauses.push(
			"(assessment.created_at < ? OR (assessment.created_at = ? AND assessment.id < ?))",
		);
		bindings.push(cursor.createdAt, cursor.createdAt, cursor.id);
	}
	bindings.push(queryLimit);
	const where = clauses.length === 0 ? "" : `WHERE ${clauses.join(" AND ")}`;
	const result = await db
		.prepare(
			`${ASSESSMENT_SELECT}
			 ${where}
			 ORDER BY assessment.created_at DESC, assessment.id DESC
			 LIMIT ?`,
		)
		.bind(...bindings)
		.all<AssessmentRow>();
	return result.results ?? [];
}

async function readAssessmentSupplements(
	db: PublicAssessmentDatabase,
	assessmentIds: readonly string[],
): Promise<AssessmentSupplements> {
	if (assessmentIds.length === 0) return { findings: new Map(), labels: new Map() };
	const placeholders = assessmentIds.map(() => "?").join(", ");
	const [findingResult, labelResult] = await Promise.all([
		db
			.prepare(
				`SELECT assessment_id, category, reason_code, position
				 FROM (
					SELECT assessment_id, category, reason_code,
						ROW_NUMBER() OVER (
							PARTITION BY assessment_id
							ORDER BY COALESCE(finding_index, id), id
						) AS position
					FROM findings
					WHERE assessment_id IN (${placeholders})
				 )
				 WHERE position <= 33
				 ORDER BY assessment_id, position`,
			)
			.bind(...assessmentIds)
			.all<FindingRow>(),
		db
			.prepare(
				`SELECT assessment_id, sequence, ver, src, uri, cid, val, neg, cts, exp, sig, position
				 FROM (
					SELECT assessment_id, sequence, ver, src, uri, cid, val, neg, cts, exp, sig,
						ROW_NUMBER() OVER (
							PARTITION BY assessment_id ORDER BY sequence
						) AS position
					FROM issued_labels
					WHERE assessment_id IN (${placeholders})
				 )
				 WHERE position <= 17
				 ORDER BY assessment_id, position`,
			)
			.bind(...assessmentIds)
			.all<LabelRow>(),
	]);
	return {
		findings: groupRows(findingResult.results ?? [], "assessment_id", MAX_FINDINGS),
		labels: groupRows(labelResult.results ?? [], "assessment_id", MAX_LABELS),
	};
}

async function readActiveLabels(
	db: PublicAssessmentDatabase,
	src: string,
	uri: string,
	cid: string,
	now: Date,
): Promise<LabelRow[]> {
	const result = await db
		.prepare(
			`WITH latest_timestamp AS (
				SELECT val, MAX(cts) AS cts
				FROM issued_labels
				WHERE src = ? AND uri = ?
				GROUP BY val
			)
				SELECT issued.assessment_id, issued.sequence, issued.ver, issued.src, issued.uri, issued.cid,
					issued.val, issued.neg, issued.cts, issued.exp, issued.sig
				FROM issued_labels issued
				JOIN latest_timestamp latest
					ON latest.val = issued.val AND latest.cts = issued.cts
				WHERE issued.src = ? AND issued.uri = ?
			ORDER BY issued.val, issued.sequence
			LIMIT ?`,
		)
		.bind(src, uri, src, uri, MAX_LABELS + 1)
		.all<LabelRow>();
	const rows = result.results ?? [];
	if (rows.length > MAX_LABELS) throw new RangeError("active label collision exceeds public limit");
	const byValue = new Map<string, LabelRow[]>();
	for (const row of rows) {
		const group = byValue.get(row.val) ?? [];
		group.push(row);
		byValue.set(row.val, group);
	}
	const active: LabelRow[] = [];
	for (const group of byValue.values()) {
		const first = group[0];
		if (!first) continue;
		const collision = group.some((candidate) => !sameLabelEvent(candidate, first));
		if (collision) {
			if (group.some((row) => row.cid === null || row.cid === cid)) {
				throw new PublicLabelConflictError("current label state has conflicting winning events");
			}
			continue;
		}
		if (isActiveApplicableLabel(first, cid, now)) active.push(first);
	}
	return active;
}

async function publicAssessment(
	row: AssessmentRow,
	labelerDid: string,
	signer: ListingLabelSigner,
	supplements: AssessmentSupplements,
): Promise<Record<string, unknown>> {
	if (row.policy_version !== PUBLIC_POLICY_VERSION) {
		throw new TypeError("assessment policy has no public policy definition");
	}
	if (subjectKindFromUri(row.subject_uri) !== row.subject_kind) {
		throw new TypeError("assessment subject kind does not match its public URI");
	}
	const state = parsePublicState(row.public_run_state);
	const manualDecision = publicManualDecision(row);
	const reasonCodes = publicReasonCodes(row);
	const findings = supplements.findings.get(row.id) ?? [];
	const labels = supplements.labels.get(row.id) ?? [];
	for (const label of labels) {
		if (
			label.src !== labelerDid ||
			label.uri !== row.subject_uri ||
			label.cid !== row.subject_cid
		) {
			throw new TypeError("assessment label is not bound to its exact public subject");
		}
	}
	return {
		id: boundedRequired(row.id, 100, "assessment ID"),
		src: labelerDid,
		subject: {
			kind: parseSubjectKind(row.subject_kind),
			uri: row.subject_uri,
			cid: row.subject_cid,
		},
		state,
		coverage: publicCoverage(row.coverage_json, row.subject_kind),
		reasonCodes,
		findings: findings.map(publicFinding),
		summary: publicSummary(state),
		assessmentSchemaVersion: ASSESSMENT_SCHEMA_VERSION,
		policyVersion: boundedRequired(row.policy_version, 128, "policy version"),
		parserVersion: boundedRequired(row.parser_version, 128, "parser version"),
		models: [
			modelDescriptor("text", row.text_model_id, row.text_prompt_hash),
			...(row.subject_kind === "release"
				? [modelDescriptor("image", row.image_model_id, row.image_prompt_hash)]
				: []),
		],
		labels: await Promise.all(labels.map((label) => publicLabel(label, signer))),
		...(manualDecision ? { manualDecision } : {}),
		createdAt: validInstant(row.created_at, "assessment creation time"),
		...(row.completed_at === null
			? {}
			: { completedAt: validInstant(row.completed_at, "assessment completion time") }),
		...(state === "superseded" && row.superseded_by_assessment_id
			? {
					supersededByAssessmentId: boundedRequired(
						row.superseded_by_assessment_id,
						100,
						"superseding assessment ID",
					),
				}
			: {}),
	};
}

function publicCoverage(value: string | null, kind: SubjectKind): Record<string, string> {
	const fallback = {
		text: "unavailable",
		links: "unavailable",
		media: kind === "profile" ? "not-present" : "unavailable",
	};
	if (value === null) return fallback;
	try {
		const parsed: unknown = JSON.parse(value);
		if (!isRecord(parsed)) return fallback;
		const text = parsed["text"];
		const links = parsed["links"];
		const media = parsed["media"];
		return {
			text: isTextCoverage(text) ? text : fallback.text,
			links: isTextCoverage(links) ? links : fallback.links,
			media: isMediaCoverage(media) ? media : fallback.media,
		};
	} catch {
		return fallback;
	}
}

function publicReasonCodes(row: AssessmentRow): string[] {
	const codes: string[] = [];
	if (row.summary_json !== null) {
		try {
			const parsed: unknown = JSON.parse(row.summary_json);
			if (isRecord(parsed) && Array.isArray(parsed["reasonCodes"])) {
				for (const code of parsed["reasonCodes"].slice(0, MAX_FINDINGS)) {
					if (
						typeof code === "string" &&
						PUBLIC_REASON_CODE_RE.test(code) &&
						PUBLIC_REASON_CODE_VALUES.has(code)
					) {
						codes.push(code);
					}
				}
			}
		} catch {
			// An invalid internal summary contributes no public data.
		}
	}
	if (row.error_code !== null) codes.push(publicOperationalReason(row.error_code));
	return [...new Set(codes)].slice(0, MAX_FINDINGS);
}

function publicOperationalReason(errorCode: string): string {
	if (errorCode === "RECORD_VERIFICATION_OR_CANONICALIZATION_FAILED") {
		return "record-verification-failed";
	}
	return "operational-error";
}

function publicManualDecision(
	row: AssessmentRow,
): { outcome: "approved" | "blocked"; reasonCode: string; decidedAt: string } | undefined {
	if (!row.manual_action || !row.manual_decided_at) return undefined;
	return {
		outcome: row.manual_action === "approve" ? "approved" : "blocked",
		reasonCode: row.manual_action === "approve" ? "operator-approved" : "operator-blocked",
		decidedAt: validInstant(row.manual_decided_at, "manual decision time"),
	};
}

function publicFinding(row: FindingRow): Record<string, string> {
	const category = publicFindingCategory(row.category);
	return {
		category,
		reasonCode:
			PUBLIC_REASON_CODE_RE.test(row.reason_code) && PUBLIC_REASON_CODE_VALUES.has(row.reason_code)
				? row.reason_code
				: "policy-finding",
		summary: publicFindingSummary(category),
	};
}

function publicFindingCategory(value: string): string {
	switch (value) {
		case "explicit-sexual-content":
		case "graphic-violence":
		case "scam-or-spam":
			return value;
		case "hateful-or-dehumanizing-content":
			return "hateful-content";
		case "phishing-or-credential-solicitation":
			return "phishing";
		case "material-impersonation":
			return "impersonation";
		case "malicious-or-deceptive-link":
			return "malicious-link";
		case "misleading-media-or-claims":
			return "misleading-content";
		default:
			return "uncertain";
	}
}

function publicFindingSummary(category: string): string {
	switch (category) {
		case "explicit-sexual-content":
			return "The assessment identified explicit sexual content in listing metadata.";
		case "hateful-content":
			return "The assessment identified hateful content in listing metadata.";
		case "graphic-violence":
			return "The assessment identified graphic violence in listing metadata.";
		case "phishing":
			return "The assessment identified potential phishing in listing metadata.";
		case "impersonation":
			return "The assessment identified potential impersonation in listing metadata.";
		case "scam-or-spam":
			return "The assessment identified potential scam or spam content in listing metadata.";
		case "malicious-link":
			return "The assessment identified a potentially malicious link in listing metadata.";
		case "misleading-content":
			return "The assessment identified potentially misleading listing metadata.";
		default:
			return "The assessment identified listing metadata that requires review.";
	}
}

function publicSummary(state: PublicAssessmentState): string {
	switch (state) {
		case "pending":
			return "The listing metadata assessment is pending.";
		case "passed":
			return "The listing metadata is eligible under the current assessment policy.";
		case "review":
			return "The listing metadata requires operator review.";
		case "blocked":
			return "An operator blocked this listing revision.";
		case "error":
			return "The listing metadata could not be assessed.";
		case "superseded":
			return "A newer assessment superseded this run.";
	}
}

async function publicLabel(
	row: LabelRow,
	signer: ListingLabelSigner,
): Promise<Record<string, unknown>> {
	if (row.ver !== 1 || (row.neg !== 0 && row.neg !== 1)) {
		throw new TypeError("stored public label is invalid");
	}
	const cts = validInstant(row.cts, "label creation time");
	const exp = row.exp === null ? undefined : validInstant(row.exp, "label expiry time");
	const signed =
		row.src === signer.issuerDid
			? await signer.sign({
					ver: 1,
					uri: row.uri,
					...(row.cid === null ? {} : { cid: row.cid }),
					val: row.val,
					...(row.neg === 1 ? { neg: true } : {}),
					cts,
					...(exp === undefined ? {} : { exp }),
				})
			: null;
	return {
		ver: 1,
		src: signed?.src ?? row.src,
		uri: row.uri,
		...(row.cid === null ? {} : { cid: row.cid }),
		val: row.val,
		...(row.neg === 1 ? { neg: true } : {}),
		cts,
		...(exp === undefined ? {} : { exp }),
		sig: { $bytes: toBase64(signed?.sig ?? new Uint8Array(row.sig)) },
	};
}

function sameLabelEvent(left: LabelRow, right: LabelRow): boolean {
	return (
		left.ver === right.ver &&
		left.src === right.src &&
		left.uri === right.uri &&
		left.cid === right.cid &&
		left.val === right.val &&
		left.neg === right.neg &&
		left.cts === right.cts &&
		left.exp === right.exp
	);
}

function isActiveApplicableLabel(row: LabelRow, cid: string, now: Date): boolean {
	return (
		row.neg === 0 &&
		(row.cid === null || row.cid === cid) &&
		(row.exp === null || isFutureInstant(row.exp, now))
	);
}

function modelDescriptor(
	purpose: "text" | "image",
	modelId: string,
	promptHash: string,
): Record<string, string> {
	return {
		purpose,
		provider: "workers-ai",
		modelId: boundedRequired(modelId, 256, `${purpose} model ID`),
		modelVersion: PROVIDER_CATALOG_MODEL_VERSION,
		promptHash: boundedRequired(promptHash, 128, `${purpose} prompt hash`),
	};
}

const PUBLIC_REASON_CODES = [
	{
		code: "manual-positive-required",
		description: "An operator-issued positive label is required before the revision is eligible.",
	},
	{
		code: "model-promotion-required",
		description: "The configured model is not promoted for automated positive decisions.",
	},
	{
		code: "policy-finding",
		description: "The metadata assessment produced a finding that requires review.",
	},
	{
		code: "required-coverage-unavailable",
		description: "At least one required metadata coverage stage could not complete.",
	},
	{ code: "operator-approved", description: "An operator approved this exact record revision." },
	{ code: "operator-blocked", description: "An operator blocked this exact record revision." },
	{
		code: "record-verification-failed",
		description: "The exact publisher record could not be verified for assessment.",
	},
	{
		code: "operational-error",
		description: "The assessment could not complete because of an operational error.",
	},
] as const;

const PUBLIC_REASON_CODE_VALUES = new Set<string>(PUBLIC_REASON_CODES.map(({ code }) => code));

const PUBLIC_LABEL_DEFINITIONS = [
	{
		value: "listing-passed",
		officialEffect: "eligible",
		subjectKinds: ["profile", "release"],
		issuanceModes: ["reviewer", "admin"],
	},
	{
		value: "listing-pending",
		officialEffect: "ineligible",
		subjectKinds: ["profile", "release"],
		issuanceModes: ["automated"],
	},
	{
		value: "listing-review",
		officialEffect: "ineligible",
		subjectKinds: ["profile", "release"],
		issuanceModes: ["automated"],
	},
	{
		value: "listing-error",
		officialEffect: "ineligible",
		subjectKinds: ["profile", "release"],
		issuanceModes: ["automated"],
	},
	{
		value: "listing-blocked",
		officialEffect: "ineligible",
		subjectKinds: ["profile", "release"],
		issuanceModes: ["reviewer", "admin"],
	},
	{
		value: "listing-overridden",
		officialEffect: "informational",
		subjectKinds: ["profile", "release"],
		issuanceModes: ["reviewer", "admin"],
	},
	{
		value: "!takedown",
		officialEffect: "redact",
		subjectKinds: ["profile", "release"],
		issuanceModes: ["admin"],
	},
] as const;

function parseListFilters(params: URLSearchParams): ListFilters | null {
	const candidate = {
		...(params.has("kind") ? { kind: params.get("kind") } : {}),
		...(params.has("uri") ? { uri: params.get("uri") } : {}),
		...(params.has("cid") ? { cid: params.get("cid") } : {}),
		...(params.has("state") ? { state: params.get("state") } : {}),
	};
	if (!is(LabelerListAssessments.mainSchema.params, { ...candidate, limit: 1 })) return null;
	if (
		candidate.kind !== undefined &&
		candidate.kind !== "profile" &&
		candidate.kind !== "release"
	) {
		return null;
	}
	if (candidate.state !== undefined && !isPublicState(candidate.state)) {
		return null;
	}
	if (
		candidate.uri !== undefined &&
		(candidate.uri === null ||
			subjectKindFromUri(candidate.uri) === null ||
			(candidate.kind !== undefined && subjectKindFromUri(candidate.uri) !== candidate.kind))
	) {
		return null;
	}
	return {
		...(candidate.kind === undefined ? {} : { kind: candidate.kind }),
		...(candidate.uri === undefined || candidate.uri === null ? {} : { uri: candidate.uri }),
		...(candidate.cid === undefined || candidate.cid === null ? {} : { cid: candidate.cid }),
		...(candidate.state === undefined ? {} : { state: candidate.state }),
	};
}

function parseLimit(value: string | null): number | null {
	if (value === null) return DEFAULT_LIST_LIMIT;
	if (!POSITIVE_INTEGER_RE.test(value)) return null;
	const limit = Number(value);
	return Number.isSafeInteger(limit) && limit <= MAX_LIST_LIMIT ? limit : null;
}

function encodeCursor(createdAt: string, id: string, filters: ListFilters): string {
	const cursor: ListCursor = {
		v: 1,
		createdAt,
		id,
		filters: filterIdentity(filters),
	};
	return toBase64Url(new TextEncoder().encode(JSON.stringify(cursor)));
}

function decodeCursor(value: string, filters: ListFilters): ListCursor | null {
	if (value.length === 0 || value.length > MAX_CURSOR_LENGTH || !BASE64URL_RE.test(value)) {
		return null;
	}
	try {
		const decoded: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(fromBase64Url(value)),
		);
		if (
			!isRecord(decoded) ||
			decoded["v"] !== 1 ||
			typeof decoded["createdAt"] !== "string" ||
			typeof decoded["id"] !== "string" ||
			typeof decoded["filters"] !== "string" ||
			decoded["filters"] !== filterIdentity(filters) ||
			decoded["id"].length === 0 ||
			decoded["id"].length > 100
		) {
			return null;
		}
		validInstant(decoded["createdAt"], "cursor creation time");
		return {
			v: 1,
			createdAt: decoded["createdAt"],
			id: decoded["id"],
			filters: decoded["filters"],
		};
	} catch {
		return null;
	}
}

function filterIdentity(filters: ListFilters): string {
	return JSON.stringify([
		filters.kind ?? null,
		filters.uri ?? null,
		filters.cid ?? null,
		filters.state ?? null,
	]);
}

function hasOnlySingleParams(
	params: URLSearchParams,
	allowed: readonly string[],
	allowMissing = false,
): boolean {
	const allowedSet = new Set(allowed);
	for (const key of new Set(params.keys())) {
		if (!allowedSet.has(key) || params.getAll(key).length !== 1) return false;
	}
	return allowMissing || allowed.every((key) => params.has(key));
}

function groupRows<Row extends Record<Key, string | null>, Key extends keyof Row>(
	rows: readonly Row[],
	key: Key,
	maxPerKey: number,
): ReadonlyMap<string, readonly Row[]> {
	const groups = new Map<string, Row[]>();
	for (const row of rows) {
		const groupKey = row[key];
		if (typeof groupKey !== "string") throw new TypeError("stored public row has no group key");
		const group = groups.get(groupKey) ?? [];
		group.push(row);
		if (group.length > maxPerKey) throw new RangeError("stored public row exceeds its limit");
		groups.set(groupKey, group);
	}
	return groups;
}

function parsePublicState(value: string): PublicAssessmentState {
	if (isPublicState(value)) return value;
	throw new TypeError("stored assessment state is not public");
}

function isPublicState(value: unknown): value is PublicAssessmentState {
	return (
		value === "pending" ||
		value === "passed" ||
		value === "review" ||
		value === "blocked" ||
		value === "error" ||
		value === "superseded"
	);
}

function parseSubjectKind(value: string): SubjectKind {
	if (value === "profile" || value === "release") return value;
	throw new TypeError("stored assessment subject kind is invalid");
}

function isTextCoverage(value: unknown): value is "complete" | "not-present" | "unavailable" {
	return value === "complete" || value === "not-present" || value === "unavailable";
}

function isMediaCoverage(
	value: unknown,
): value is "complete" | "not-present" | "partial" | "unavailable" {
	return isTextCoverage(value) || value === "partial";
}

function isFutureInstant(value: string, now: Date): boolean {
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) && timestamp > now.getTime();
}

function validInstant(value: string, label: string): string {
	const timestamp = Date.parse(value);
	if (!Number.isFinite(timestamp)) throw new TypeError(`${label} is invalid`);
	return value;
}

function boundedRequired(value: string, maxLength: number, label: string): string {
	if (value.length === 0 || value.length > maxLength) throw new TypeError(`${label} is invalid`);
	return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertLexiconOutput(schema: Parameters<typeof is>[0], value: unknown): void {
	if (!is(schema, value)) throw new TypeError("public assessment output failed lexicon validation");
}

function invalidRequest(message: string): Response {
	return xrpcError("InvalidRequest", message, 400);
}

function xrpcError(
	error: string,
	message: string,
	status: number,
	headers: HeadersInit = {},
): Response {
	return jsonResponse({ error, message }, { status, headers });
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("cache-control", "no-store");
	headers.set("content-type", "application/json; charset=utf-8");
	return new Response(JSON.stringify(value), { ...init, headers });
}

function toBase64(value: Uint8Array): string {
	let binary = "";
	for (let offset = 0; offset < value.length; offset += 8_192) {
		binary += String.fromCharCode(...value.subarray(offset, offset + 8_192));
	}
	return btoa(binary);
}

function toBase64Url(value: Uint8Array): string {
	return toBase64(value).replaceAll("+", "-").replaceAll("/", "_").replace(BASE64_PADDING_RE, "");
}

function fromBase64Url(value: string): Uint8Array {
	const standard = value.replaceAll("-", "+").replaceAll("_", "/");
	const padded = standard.padEnd(Math.ceil(standard.length / 4) * 4, "=");
	return Uint8Array.from(atob(padded), (character) => character.charCodeAt(0));
}
