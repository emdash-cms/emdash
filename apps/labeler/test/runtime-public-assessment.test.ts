import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { is } from "@atcute/lexicons/validations";
import {
	LabelerGetAssessment,
	LabelerGetCurrentAssessment,
	LabelerGetPolicy,
	LabelerListAssessments,
	NSID,
} from "@emdash-cms/registry-lexicons";
import { parseSignedListingLabel, verifyListingLabel } from "@emdash-cms/registry-moderation";
import { beforeAll, describe, expect, it } from "vitest";

import { IMAGE_PROMPT_HASH, TEXT_PROMPT_HASH } from "../src/ai/prompts.js";
import { handlePublicAssessmentXrpc } from "../src/public-assessment.js";

class NodeD1Database {
	constructor(private readonly database: DatabaseSync) {}

	prepare(query: string): NodeD1Statement {
		return new NodeD1Statement(this.database.prepare(query));
	}

	async batch(statements: readonly NodeD1Statement[]): Promise<void> {
		this.database.exec("BEGIN");
		try {
			for (const statement of statements) await statement.run();
			this.database.exec("COMMIT");
		} catch (error) {
			this.database.exec("ROLLBACK");
			throw error;
		}
	}
}

class NodeD1Statement {
	private values: SQLInputValue[] = [];

	constructor(private readonly statement: StatementSync) {}

	bind(...values: unknown[]): this {
		this.values = values.map(sqliteValue);
		return this;
	}

	async first<Row = Record<string, unknown>>(): Promise<Row | null> {
		return (this.statement.get(...this.values) as Row | undefined) ?? null;
	}

	async all<Row = Record<string, unknown>>(): Promise<{ results: Row[] }> {
		return { results: this.statement.all(...this.values) as Row[] };
	}

	async run(): Promise<{ meta: { changes: number } }> {
		const result = this.statement.run(...this.values);
		return { meta: { changes: Number(result.changes) } };
	}
}

function sqliteValue(value: unknown): SQLInputValue {
	if (value === null || typeof value === "number" || typeof value === "string") return value;
	if (value instanceof Uint8Array) return value;
	if (value instanceof ArrayBuffer) return new Uint8Array(value);
	throw new TypeError("Unsupported test SQLite binding");
}

const PROFILE_CID = "bafkreif4oaymum54i5qefbwoblrt5zasfjhpyhyvacpseqtehi3queew5m";
const OTHER_CID = "bafyreigh2akiscaildc4mscz4uzpcbap5jxg26eecmrf6cmnvkzkjmoixe";
const BASE_URL = "https://labels.emdashcms.com";
const CREATED_AT = "2026-08-24T12:00:00.000Z";
const PRIVATE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE";
const PUBLIC_MULTIKEY = "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ";
const sqlite = new DatabaseSync(":memory:");
const d1 = new NodeD1Database(sqlite);
const env = {
	DB: d1,
	LABELER_DID: "did:web:labels.emdashcms.com",
	LABELER_SERVICE_URL: BASE_URL,
	LABEL_SIGNING_PRIVATE_KEY: PRIVATE_KEY,
	LABEL_SIGNING_PUBLIC_KEY: PUBLIC_MULTIKEY,
	LABELER_POLICY_VERSION: "listing-metadata-v1",
	LABELER_PARSER_VERSION: "canonical-listing-input-v1",
	LABELER_TEXT_MODEL_ID: "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
	LABELER_IMAGE_MODEL_ID: "@cf/qwen/qwen3.8-27b",
} satisfies Parameters<typeof handlePublicAssessmentXrpc>[1];

beforeAll(() => {
	for (const migration of ["0001_initial.sql", "0002_finding_identity.sql"]) {
		sqlite.exec(
			readFileSync(
				fileURLToPath(new URL(`../migrations/${migration}`, import.meta.url).href),
				"utf8",
			),
		);
	}
});

describe("public assessment XRPC", () => {
	it("maps an assessment, finding, signed label, and manual decision without private evidence", async () => {
		const seeded = await seedAssessment("detail", {
			state: "review",
			coverage: { text: "complete", links: "complete", media: "not-present" },
			summary: {
				reasonCodes: ["policy-finding"],
				prompt: "SYSTEM PROMPT MUST NOT LEAK",
				response: "RAW MODEL RESPONSE MUST NOT LEAK",
				email: "publisher-private@example.test",
			},
			canonicalInput: {
				description: "RAW PUBLISHER METADATA MUST NOT LEAK",
				email: "publisher-private@example.test",
			},
		});
		await env.DB.prepare(
			`INSERT INTO findings
			 (assessment_id, finding_index, category, reason_code, public_summary,
			  evidence_refs_json, created_at)
			 VALUES (?, 0, 'phishing-or-credential-solicitation', 'policy-finding', ?, ?, ?)`,
		)
			.bind(
				seeded.id,
				"RAW FINDING MODEL OUTPUT publisher-private@example.test MUST NOT LEAK",
				'["profile.description","publisher-private@example.test"]',
				CREATED_AT,
			)
			.run();
		await insertAutomatedLabel(seeded, "listing-review", [1, 2, 3]);
		await insertManualDecision(
			seeded,
			"block",
			"Private operator note publisher-private@example.test",
		);
		await insertStandaloneLabel(seeded, {
			value: "listing-blocked",
			createdAt: "2026-08-24T13:00:00.000Z",
			signature: [4, 5, 6],
		});

		const response = await request(
			NSID.labelerGetAssessment,
			new URLSearchParams({ id: seeded.id }),
		);
		expect(response?.status).toBe(200);
		const body = await response!.json<Record<string, unknown>>();
		expect(is(LabelerGetAssessment.mainSchema.output.schema, body)).toBe(true);
		expect(body).toMatchObject({
			id: seeded.id,
			src: env.LABELER_DID,
			subject: { kind: "profile", uri: seeded.uri, cid: PROFILE_CID },
			state: "review",
			coverage: { text: "complete", links: "complete", media: "not-present" },
			reasonCodes: ["policy-finding"],
			findings: [
				{
					category: "phishing",
					reasonCode: "policy-finding",
					summary: "The assessment identified potential phishing in listing metadata.",
				},
			],
			labels: [
				expect.objectContaining({
					val: "listing-review",
					sig: { $bytes: expect.any(String) },
				}),
			],
			manualDecision: {
				outcome: "blocked",
				reasonCode: "operator-blocked",
				decidedAt: "2026-08-24T13:00:00.000Z",
			},
		});
		await expectCurrentSignature((body["labels"] as unknown[])[0]);

		const currentResponse = await request(
			NSID.labelerGetCurrentAssessment,
			new URLSearchParams({ kind: "profile", uri: seeded.uri, cid: PROFILE_CID }),
		);
		const current = await currentResponse!.json<Record<string, unknown>>();
		expect(current).toMatchObject({
			assessment: {
				state: "review",
				labels: [expect.objectContaining({ val: "listing-review" })],
				manualDecision: { outcome: "blocked", reasonCode: "operator-blocked" },
			},
			activeLabels: expect.arrayContaining([
				expect.objectContaining({ val: "listing-blocked", sig: { $bytes: expect.any(String) } }),
			]),
		});
		const block = (current["activeLabels"] as unknown[]).find(
			(label) =>
				typeof label === "object" &&
				label !== null &&
				Object.getOwnPropertyDescriptor(label, "val")?.value === "listing-blocked",
		);
		await expectCurrentSignature(block);
		const serialized = JSON.stringify(body);
		for (const privateValue of [
			"SYSTEM PROMPT MUST NOT LEAK",
			"RAW MODEL RESPONSE MUST NOT LEAK",
			"RAW PUBLISHER METADATA MUST NOT LEAK",
			"RAW FINDING MODEL OUTPUT",
			"publisher-private@example.test",
			"Private operator note",
			"profile.description",
		]) {
			expect(serialized).not.toContain(privateValue);
		}
	});

	it("returns the current pointer and only active labels applicable to the requested CID", async () => {
		const seeded = await seedAssessment("current", { state: "review" });
		await insertStandaloneLabel(seeded, {
			value: "listing-review",
			createdAt: "2026-08-24T12:01:00.000Z",
			signature: [10],
		});
		await insertStandaloneLabel(seeded, {
			value: "listing-review",
			negate: true,
			createdAt: "2026-08-24T12:02:00.000Z",
			signature: [11],
		});
		await insertStandaloneLabel(seeded, {
			value: "listing-passed",
			createdAt: "2026-08-24T12:03:00.000Z",
			signature: [12],
		});
		await insertStandaloneLabel(seeded, {
			value: "listing-error",
			cid: OTHER_CID,
			createdAt: "2026-08-24T12:04:00.000Z",
			signature: [13],
		});
		await insertStandaloneLabel(seeded, {
			value: "listing-pending",
			createdAt: "2026-08-24T12:05:00.000Z",
			expiresAt: "2026-08-24T12:06:00.000Z",
			signature: [14],
		});

		const response = await request(
			NSID.labelerGetCurrentAssessment,
			new URLSearchParams({ kind: "profile", uri: seeded.uri, cid: PROFILE_CID }),
			new Date("2026-08-24T12:10:00.000Z"),
		);
		expect(response?.status).toBe(200);
		const body = await response!.json<Record<string, unknown>>();
		expect(is(LabelerGetCurrentAssessment.mainSchema.output.schema, body)).toBe(true);
		expect(body).toMatchObject({
			src: env.LABELER_DID,
			subject: { kind: "profile", uri: seeded.uri, cid: PROFILE_CID },
			activeLabels: [
				expect.objectContaining({
					val: "listing-passed",
					sig: { $bytes: expect.any(String) },
				}),
			],
		});
		await expectCurrentSignature((body["activeLabels"] as unknown[])[0]);

		const invalidKind = await request(
			NSID.labelerGetCurrentAssessment,
			new URLSearchParams({ kind: "release", uri: seeded.uri, cid: PROFILE_CID }),
		);
		expect(await errorBody(invalidKind)).toEqual({
			status: 400,
			error: "InvalidRequest",
		});
	});

	it("fails closed instead of presenting colliding candidates as active labels", async () => {
		const seeded = await seedAssessment("current-collision", { state: "review" });
		await insertStandaloneLabel(seeded, {
			value: "listing-blocked",
			cid: OTHER_CID,
			createdAt: "2026-08-24T12:03:00.000Z",
			signature: [20],
		});
		await insertStandaloneLabel(seeded, {
			value: "listing-blocked",
			negate: true,
			createdAt: "2026-08-24T12:03:00.000Z",
			signature: [21],
		});

		const response = await request(
			NSID.labelerGetCurrentAssessment,
			new URLSearchParams({ kind: "profile", uri: seeded.uri, cid: PROFILE_CID }),
		);
		expect(await errorBody(response)).toEqual({ status: 409, error: "ConflictingLabels" });
	});

	it("pages by a filter-bound descending keyset cursor", async () => {
		const first = await seedAssessment("page-a", {
			state: "review",
			createdAt: "2026-08-24T14:00:00.000Z",
		});
		const second = await seedAssessment("page-b", {
			state: "review",
			createdAt: "2026-08-24T13:00:00.000Z",
		});
		const third = await seedAssessment("page-c", {
			state: "review",
			createdAt: "2026-08-24T12:00:00.000Z",
		});
		const filters = new URLSearchParams({
			uri: first.uri,
			cid: PROFILE_CID,
			state: "review",
			limit: "2",
		});
		await repointAssessment(second, first.uri);
		await repointAssessment(third, first.uri);

		const firstResponse = await request(NSID.labelerListAssessments, filters);
		const firstBody = await firstResponse!.json<{
			assessments: Array<{ id: string }>;
			cursor: string;
		}>();
		expect(is(LabelerListAssessments.mainSchema.output.schema, firstBody)).toBe(true);
		expect(firstBody.assessments.map(({ id }) => id)).toEqual([first.id, second.id]);
		expect(firstBody.cursor.length).toBeLessThanOrEqual(1_024);

		filters.set("cursor", firstBody.cursor);
		const secondResponse = await request(NSID.labelerListAssessments, filters);
		const secondBody = await secondResponse!.json<{
			assessments: Array<{ id: string }>;
			cursor?: string;
		}>();
		expect(secondBody.assessments.map(({ id }) => id)).toEqual([third.id]);
		expect(secondBody).not.toHaveProperty("cursor");

		filters.set("state", "blocked");
		const reused = await request(NSID.labelerListAssessments, filters);
		expect(await errorBody(reused)).toEqual({ status: 400, error: "InvalidCursor" });
	});

	it("orders manual decisions by authority time before insertion ID", async () => {
		const seeded = await seedAssessment("manual-order", { state: "review" });
		await insertManualDecision(
			seeded,
			"approve",
			"The newer authority decision",
			"2026-08-24T14:00:00.000Z",
		);
		await insertManualDecision(
			seeded,
			"block",
			"Inserted later but created earlier",
			"2026-08-24T13:00:00.000Z",
		);

		const response = await request(
			NSID.labelerGetAssessment,
			new URLSearchParams({ id: seeded.id }),
		);
		const body = await response!.json<Record<string, unknown>>();
		expect(body).toMatchObject({
			state: "review",
			manualDecision: {
				outcome: "approved",
				reasonCode: "operator-approved",
				decidedAt: "2026-08-24T14:00:00.000Z",
			},
		});

		const reviewList = await request(
			NSID.labelerListAssessments,
			new URLSearchParams({ uri: seeded.uri, cid: seeded.cid, state: "review" }),
		);
		expect(await reviewList!.json()).toMatchObject({
			assessments: [expect.objectContaining({ id: seeded.id, state: "review" })],
		});
		const passedList = await request(
			NSID.labelerListAssessments,
			new URLSearchParams({ uri: seeded.uri, cid: seeded.cid, state: "passed" }),
		);
		expect(await passedList!.json()).toEqual({ assessments: [] });
	});

	it("maps operational verification failures to a bounded public reason", async () => {
		const seeded = await seedAssessment("verification-error", {
			state: "error",
			errorCode: "RECORD_VERIFICATION_OR_CANONICALIZATION_FAILED",
			canonicalInput: {
				rawRecord: "UNVERIFIED RAW RECORD",
				email: "private-verification@example.test",
			},
		});
		const response = await request(
			NSID.labelerGetAssessment,
			new URLSearchParams({ id: seeded.id }),
		);
		const body = await response!.json<Record<string, unknown>>();
		expect(body).toMatchObject({
			state: "error",
			coverage: { text: "unavailable", links: "unavailable", media: "not-present" },
			reasonCodes: ["record-verification-failed"],
			summary: "The listing metadata could not be assessed.",
		});
		const serialized = JSON.stringify(body);
		expect(serialized).not.toContain("RECORD_VERIFICATION_OR_CANONICALIZATION_FAILED");
		expect(serialized).not.toContain("UNVERIFIED RAW RECORD");
		expect(serialized).not.toContain("private-verification@example.test");
	});

	it("returns the metadata-only public policy in its lexicon shape", async () => {
		const response = await request(NSID.labelerGetPolicy);
		expect(response?.status).toBe(200);
		const body = await response!.json<Record<string, unknown>>();
		expect(is(LabelerGetPolicy.mainSchema.output.schema, body)).toBe(true);
		expect(body).toMatchObject({
			labelerDid: env.LABELER_DID,
			policyVersion: env.LABELER_POLICY_VERSION,
			supportedSubjects: [
				{ kind: "profile", collection: NSID.packageProfile },
				{ kind: "release", collection: NSID.packageRelease },
			],
			publicApi: {
				baseUrl: `${env.LABELER_SERVICE_URL}/xrpc/`,
				getAssessmentNsid: NSID.labelerGetAssessment,
				getCurrentAssessmentNsid: NSID.labelerGetCurrentAssessment,
				listAssessmentsNsid: NSID.labelerListAssessments,
				getPolicyNsid: NSID.labelerGetPolicy,
			},
			models: [
				expect.objectContaining({ modelVersion: "provider-catalog-id" }),
				expect.objectContaining({ modelVersion: "provider-catalog-id" }),
			],
		});
		expect(JSON.stringify(body)).not.toMatch(/package bytes|source code|manifest|sbom/iu);
	});

	it("uses stable XRPC errors and ignores paths owned by other handlers", async () => {
		const invalid = await request(
			NSID.labelerGetAssessment,
			new URLSearchParams({ id: "", extra: "value" }),
		);
		expect(await errorBody(invalid)).toEqual({ status: 400, error: "InvalidRequest" });

		const missing = await request(
			NSID.labelerGetAssessment,
			new URLSearchParams({ id: "missing-assessment" }),
		);
		expect(await errorBody(missing)).toEqual({ status: 404, error: "NotFound" });

		const invalidLimit = await request(
			NSID.labelerListAssessments,
			new URLSearchParams({ limit: "101" }),
		);
		expect(await errorBody(invalidLimit)).toEqual({ status: 400, error: "InvalidRequest" });

		const post = await handlePublicAssessmentXrpc(
			new Request(`${BASE_URL}/xrpc/${NSID.labelerGetPolicy}`, { method: "POST" }),
			env,
		);
		expect(post?.status).toBe(405);
		expect(post?.headers.get("allow")).toBe("GET");
		expect(await handlePublicAssessmentXrpc(new Request(`${BASE_URL}/health`), env)).toBeNull();
	});
});

async function request(
	nsid: string,
	params = new URLSearchParams(),
	now = new Date("2026-08-24T15:00:00.000Z"),
): Promise<Response | null> {
	const url = new URL(`/xrpc/${nsid}`, BASE_URL);
	url.search = params.toString();
	return handlePublicAssessmentXrpc(new Request(url), env, now);
}

async function errorBody(response: Response | null): Promise<{ status: number; error: string }> {
	const body = await response!.json<{ error: string }>();
	return { status: response!.status, error: body.error };
}

async function expectCurrentSignature(value: unknown): Promise<void> {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new TypeError("public label is invalid");
	}
	const record = Object.fromEntries(
		Object.keys(value).map((key) => [key, Object.getOwnPropertyDescriptor(value, key)?.value]),
	);
	const signature = record["sig"];
	if (!signature || typeof signature !== "object" || Array.isArray(signature)) {
		throw new TypeError("public label signature is invalid");
	}
	const encoded = Object.getOwnPropertyDescriptor(signature, "$bytes")?.value;
	if (typeof encoded !== "string") throw new TypeError("public label signature is invalid");
	const { sig: _sig, ...unsigned } = record;
	const label = parseSignedListingLabel({
		...unsigned,
		sig: Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0)),
	});
	await expect(
		verifyListingLabel({
			label,
			resolveDid: async () => ({
				id: env.LABELER_DID,
				verificationMethod: [
					{
						id: "#atproto_label",
						type: "Multikey",
						controller: env.LABELER_DID,
						publicKeyMultibase: PUBLIC_MULTIKEY,
					},
				],
			}),
		}),
	).resolves.toBeDefined();
}

interface SeededAssessment {
	id: string;
	uri: string;
	cid: string;
}

async function seedAssessment(
	suffix: string,
	options: {
		state: "pending" | "running" | "passed" | "review" | "blocked" | "error";
		coverage?: unknown;
		summary?: unknown;
		canonicalInput?: unknown;
		errorCode?: string;
		createdAt?: string;
	},
): Promise<SeededAssessment> {
	const id = `assessment-${suffix}`;
	const uri = `at://did:plc:publicassessmentfixture/com.emdashcms.experimental.package.profile/${suffix}`;
	const createdAt = options.createdAt ?? CREATED_AT;
	await env.DB.batch([
		env.DB.prepare(
			`INSERT INTO subjects
			 (uri, cid, kind, publisher_did, first_observed_at, last_observed_at)
			 VALUES (?, ?, 'profile', 'did:plc:publicassessmentfixture', ?, ?)`,
		).bind(uri, PROFILE_CID, createdAt, createdAt),
		env.DB.prepare(
			`INSERT INTO current_subjects (uri, cid, kind, updated_at)
			 VALUES (?, ?, 'profile', ?)`,
		).bind(uri, PROFILE_CID, createdAt),
		env.DB.prepare(
			`INSERT INTO assessments
			 (id, run_key, subject_uri, subject_cid, subject_kind, policy_version,
			  parser_version, text_model_id, text_prompt_hash, image_model_id,
			  image_prompt_hash, logical_trigger_id, state, coverage_json,
			  canonical_input_json, summary_json, error_code, created_at, updated_at, completed_at)
			 VALUES (?, ?, ?, ?, 'profile', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		).bind(
			id,
			id,
			uri,
			PROFILE_CID,
			env.LABELER_POLICY_VERSION,
			env.LABELER_PARSER_VERSION,
			env.LABELER_TEXT_MODEL_ID,
			TEXT_PROMPT_HASH,
			env.LABELER_IMAGE_MODEL_ID,
			IMAGE_PROMPT_HASH,
			`trigger-${suffix}`,
			options.state,
			options.coverage === undefined ? null : JSON.stringify(options.coverage),
			options.canonicalInput === undefined ? null : JSON.stringify(options.canonicalInput),
			options.summary === undefined ? null : JSON.stringify(options.summary),
			options.errorCode ?? null,
			createdAt,
			createdAt,
			options.state === "pending" || options.state === "running" ? null : createdAt,
		),
		env.DB.prepare(
			`INSERT INTO current_assessments (subject_uri, subject_cid, assessment_id, updated_at)
			 VALUES (?, ?, ?, ?)`,
		).bind(uri, PROFILE_CID, id, createdAt),
	]);
	return { id, uri, cid: PROFILE_CID };
}

async function repointAssessment(assessment: SeededAssessment, uri: string): Promise<void> {
	await env.DB.prepare(`UPDATE assessments SET subject_uri = ? WHERE id = ?`)
		.bind(uri, assessment.id)
		.run();
}

async function insertAutomatedLabel(
	assessment: SeededAssessment,
	value: string,
	signature: readonly number[],
): Promise<void> {
	await insertLabel(assessment, {
		assessmentId: assessment.id,
		value,
		createdAt: "2026-08-24T12:01:00.000Z",
		signature,
	});
}

async function insertStandaloneLabel(
	assessment: SeededAssessment,
	options: {
		value: string;
		cid?: string;
		negate?: boolean;
		createdAt: string;
		expiresAt?: string;
		signature: readonly number[];
	},
): Promise<void> {
	await insertLabel(assessment, { ...options, standalone: true });
}

async function insertLabel(
	assessment: SeededAssessment,
	options: {
		assessmentId?: string;
		value: string;
		cid?: string;
		negate?: boolean;
		createdAt: string;
		expiresAt?: string;
		signature: readonly number[];
		standalone?: boolean;
	},
): Promise<void> {
	const idempotencyKey = [
		"public",
		assessment.id,
		options.value,
		options.createdAt,
		options.cid ?? assessment.cid,
		options.negate ? "negated" : "positive",
	].join(":");
	const assessmentId = options.standalone ? null : (options.assessmentId ?? assessment.id);
	await env.DB.prepare(
		`INSERT INTO issued_labels
		 (idempotency_key, assessment_id, assessment_policy_version, assessment_outcome,
		  actor_did, actor_role, reason, ver, src, uri, cid, val, neg, cts, exp, sig,
		  signing_key_id, publication_pending, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, 'PRIVATE LABEL REASON', 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?)`,
	)
		.bind(
			idempotencyKey,
			assessmentId,
			options.standalone ? null : env.LABELER_POLICY_VERSION,
			options.standalone ? null : valueToOutcome(options.value),
			env.LABELER_DID,
			options.standalone ? "reviewer" : "automation",
			env.LABELER_DID,
			assessment.uri,
			options.cid ?? assessment.cid,
			options.value,
			options.negate ? 1 : 0,
			options.createdAt,
			options.expiresAt ?? null,
			Uint8Array.from(options.signature),
			`${env.LABELER_DID}#atproto_label`,
			options.createdAt,
		)
		.run();
}

function valueToOutcome(value: string): "pending" | "passed" | "review" | "error" {
	if (value === "listing-pending") return "pending";
	if (value === "listing-passed") return "passed";
	if (value === "listing-error") return "error";
	return "review";
}

async function insertManualDecision(
	assessment: SeededAssessment,
	action: "approve" | "block",
	reason: string,
	createdAt = "2026-08-24T13:00:00.000Z",
): Promise<void> {
	await env.DB.prepare(
		`INSERT INTO operator_actions
		 (actor_did, actor_role, action, subject_uri, subject_cid, reason,
		  idempotency_key, created_at)
		 VALUES ('did:example:reviewer', 'reviewer', ?, ?, ?, ?, ?, ?)`,
	)
		.bind(
			action,
			assessment.uri,
			assessment.cid,
			reason,
			`manual-${assessment.id}-${action}-${createdAt}`,
			createdAt,
		)
		.run();
}
