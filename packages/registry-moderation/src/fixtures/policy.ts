import { MODERATION_FINDING_CATEGORIES, type ListingModerationPolicy } from "../policy.js";

export const FIXTURE_LABELER_DID = "did:web:listing-labeler.emdashcms.test";
export const FIXTURE_STATE_DID = "did:web:state-labeler.emdashcms.test";
export const FIXTURE_REDACTION_DID = "did:web:redaction-labeler.emdashcms.test";

export const INITIAL_LISTING_POLICY_FIXTURE = {
	schemaVersion: 1,
	policyVersion: "listing-metadata-v1",
	effectiveAt: "2026-08-24T00:00:00.000Z",
	requiredPositiveSources: [FIXTURE_LABELER_DID],
	acceptedStateSources: [FIXTURE_STATE_DID],
	redactionSources: [FIXTURE_REDACTION_DID],
	autoPass: "disabled",
	prohibitedCategories: MODERATION_FINDING_CATEGORIES,
} as const satisfies ListingModerationPolicy;
