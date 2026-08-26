import { createD1ListingLabelIssuer, type ListingLabelIssuer } from "../src/labels/issuer.js";
import type {
	ExactListingSubject,
	ListingLabelProposal,
	OperatorDecisionContext,
	OperatorIssuanceContext,
} from "../src/labels/types.js";

export const ISSUER_DID = "did:example:listing-labeler";
export const REVIEWER_DID = "did:example:reviewer";
export const ADMIN_DID = "did:example:admin";
export const PUBLISHER_DID = "did:example:publisher";
export const PROFILE_URI =
	"at://did:example:publisher/com.emdashcms.experimental.package.profile/example";
export const RELEASE_URI =
	"at://did:example:publisher/com.emdashcms.experimental.package.release/1.0.0";
export const SUBJECT_CID = "bafkreif4oaymum54i5qefbwoblrt5zasfjhpyhyvacpseqtehi3queew5m";
export const PROFILE_SUBJECT: ExactListingSubject = {
	kind: "profile",
	uri: PROFILE_URI,
	cid: SUBJECT_CID,
};

const PRIVATE_KEY = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAE";
const PUBLIC_MULTIKEY = "zDnaepsL7AXenJkVYdkh5KuKsSU7Ykh7kyXaLLU7auN9FWSiZ";

export function createTestIssuer(
	db: D1Database,
	overrides: Partial<Parameters<typeof createD1ListingLabelIssuer>[0]> = {},
): Promise<ListingLabelIssuer> {
	const { automationPolicyVersions = ["policy-v1"], ...rest } = overrides;
	return createD1ListingLabelIssuer({
		db,
		automationPolicyVersions,
		issuerDid: ISSUER_DID,
		privateKey: PRIVATE_KEY,
		resolveDid: async () => ({
			id: ISSUER_DID,
			verificationMethod: [
				{
					id: "#atproto_label",
					type: "Multikey",
					controller: ISSUER_DID,
					publicKeyMultibase: PUBLIC_MULTIKEY,
				},
			],
		}),
		...rest,
	});
}

export function profileProposal(
	value: "listing-passed" | "listing-blocked" | "listing-overridden" = "listing-passed",
	negate = false,
): ListingLabelProposal {
	return {
		subject: { kind: "profile", uri: PROFILE_URI, cid: SUBJECT_CID },
		value,
		...(negate ? { negate: true } : {}),
	};
}

export function reviewerContext(
	id: string,
	action: OperatorIssuanceContext["operatorAction"]["action"] = "approve",
): OperatorIssuanceContext {
	return {
		actorDid: REVIEWER_DID,
		role: "reviewer",
		reason: "Fixture decision",
		idempotencyKey: `label-${id}`,
		operatorAction: { action, idempotencyKey: `action-${id}` },
	};
}

export function decisionContext(id: string): OperatorDecisionContext {
	return {
		actorDid: REVIEWER_DID,
		role: "reviewer",
		reason: "Fixture decision",
		idempotencyKey: `decision-${id}`,
	};
}

export async function seedAssessment(
	db: D1Database,
	input: {
		id: string;
		state: "pending" | "running" | "passed" | "review" | "error";
		uri?: string;
		cid?: string;
		policyVersion?: string;
	},
): Promise<void> {
	const uri = input.uri ?? PROFILE_URI;
	const cid = input.cid ?? SUBJECT_CID;
	const now = "2026-08-24T12:00:00.000Z";
	await db.batch([
		db
			.prepare(
				`INSERT OR IGNORE INTO subjects
				 (uri, cid, kind, publisher_did, first_observed_at, last_observed_at)
				 VALUES (?, ?, 'profile', ?, ?, ?)`,
			)
			.bind(uri, cid, PUBLISHER_DID, now, now),
		db
			.prepare(
				`INSERT INTO current_subjects (uri, cid, kind, updated_at)
				 VALUES (?, ?, 'profile', ?)
				 ON CONFLICT(uri) DO UPDATE SET cid = excluded.cid, updated_at = excluded.updated_at`,
			)
			.bind(uri, cid, now),
		db
			.prepare(
				`INSERT INTO assessments
				 (id, run_key, subject_uri, subject_cid, subject_kind, policy_version,
				  parser_version, text_model_id, text_prompt_hash, image_model_id,
				  image_prompt_hash, logical_trigger_id, state, created_at, updated_at)
				 VALUES (?, ?, ?, ?, 'profile', ?, 'parser-v1', 'text-v1', 'text-prompt-v1',
				         'image-v1', 'image-prompt-v1', 'test', ?, ?, ?)`,
			)
			.bind(
				input.id,
				input.id,
				uri,
				cid,
				input.policyVersion ?? "policy-v1",
				input.state,
				now,
				now,
			),
		db
			.prepare(
				`INSERT INTO current_assessments (subject_uri, subject_cid, assessment_id, updated_at)
				 VALUES (?, ?, ?, ?)
				 ON CONFLICT(subject_uri, subject_cid) DO UPDATE SET
				 assessment_id = excluded.assessment_id, updated_at = excluded.updated_at`,
			)
			.bind(uri, cid, input.id, now),
	]);
}

export function labelDidDocument() {
	return {
		id: ISSUER_DID,
		verificationMethod: [
			{
				id: "#atproto_label",
				type: "Multikey",
				controller: ISSUER_DID,
				publicKeyMultibase: PUBLIC_MULTIKEY,
			},
		],
	};
}
