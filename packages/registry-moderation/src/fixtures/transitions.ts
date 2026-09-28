import type { ListingSubjectRevision, ListingVisibilityState } from "../evaluate.js";
import { LISTING_LABELS, type ListingLabelEvent } from "../labels.js";
import { FIXTURE_PROFILE_CID, FIXTURE_PROFILE_URI, FIXTURE_PUBLISHER_DID } from "./inputs.js";
import { FIXTURE_LABELER_DID, FIXTURE_REDACTION_DID, FIXTURE_STATE_DID } from "./policy.js";

export const FIXTURE_NEW_PROFILE_CID =
	"bafyreiadambqgaydambqgaydambqgaydambqgaydambqgaydambqgaydam";

const OLD_PROFILE: ListingSubjectRevision = {
	uri: FIXTURE_PROFILE_URI,
	cid: FIXTURE_PROFILE_CID,
	kind: "profile",
	publisherDid: FIXTURE_PUBLISHER_DID,
};

const NEW_PROFILE: ListingSubjectRevision = { ...OLD_PROFILE, cid: FIXTURE_NEW_PROFILE_CID };

function label(
	val: ListingLabelEvent["val"],
	cts: string,
	options: Partial<ListingLabelEvent> = {},
): ListingLabelEvent {
	return {
		ver: 1,
		src: FIXTURE_LABELER_DID,
		uri: FIXTURE_PROFILE_URI,
		cid: FIXTURE_PROFILE_CID,
		val,
		cts,
		...options,
	};
}

const OLD_PASS = label(LISTING_LABELS.passed, "2026-08-24T00:00:01.000Z");
const NEW_PENDING = label(LISTING_LABELS.pending, "2026-08-24T00:00:02.000Z", {
	cid: FIXTURE_NEW_PROFILE_CID,
});
const NEW_REVIEW = label(LISTING_LABELS.review, "2026-08-24T00:00:03.000Z", {
	cid: FIXTURE_NEW_PROFILE_CID,
});
const NEW_ERROR = label(LISTING_LABELS.error, "2026-08-24T00:00:03.000Z", {
	cid: FIXTURE_NEW_PROFILE_CID,
});
const NEW_BLOCK = label(LISTING_LABELS.blocked, "2026-08-24T00:00:04.000Z", {
	cid: FIXTURE_NEW_PROFILE_CID,
});
const NEW_PASS = label(LISTING_LABELS.passed, "2026-08-24T00:00:05.000Z", {
	cid: FIXTURE_NEW_PROFILE_CID,
});
const NEGATE_NEW_PASS = label(LISTING_LABELS.passed, "2026-08-24T00:00:06.000Z", {
	cid: FIXTURE_NEW_PROFILE_CID,
	neg: true,
});

export interface ListingTransitionFixture {
	id: string;
	subject: ListingSubjectRevision;
	labels: readonly ListingLabelEvent[];
	expectedState: ListingVisibilityState;
}

export const LISTING_TRANSITION_FIXTURES: readonly ListingTransitionFixture[] = [
	{ id: "unlabelled", subject: OLD_PROFILE, labels: [], expectedState: "unavailable" },
	{
		id: "override-alone",
		subject: OLD_PROFILE,
		labels: [label(LISTING_LABELS.overridden, "2026-08-24T00:00:01.000Z")],
		expectedState: "unavailable",
	},
	{ id: "old-pass", subject: OLD_PROFILE, labels: [OLD_PASS], expectedState: "passed" },
	{
		id: "old-pass-new-pending-old-view",
		subject: OLD_PROFILE,
		labels: [OLD_PASS, NEW_PENDING],
		expectedState: "passed",
	},
	{
		id: "old-pass-new-pending-new-view",
		subject: NEW_PROFILE,
		labels: [OLD_PASS, NEW_PENDING],
		expectedState: "unavailable",
	},
	{
		id: "old-pass-new-review-old-view",
		subject: OLD_PROFILE,
		labels: [OLD_PASS, NEW_REVIEW],
		expectedState: "passed",
	},
	{
		id: "old-pass-new-error-old-view",
		subject: OLD_PROFILE,
		labels: [OLD_PASS, NEW_ERROR],
		expectedState: "passed",
	},
	{
		id: "new-review-unavailable",
		subject: NEW_PROFILE,
		labels: [OLD_PASS, NEW_REVIEW],
		expectedState: "unavailable",
	},
	{
		id: "new-error-unavailable",
		subject: NEW_PROFILE,
		labels: [OLD_PASS, NEW_ERROR],
		expectedState: "unavailable",
	},
	{
		id: "old-pass-new-block-old-view",
		subject: OLD_PROFILE,
		labels: [OLD_PASS, NEW_BLOCK],
		expectedState: "passed",
	},
	{
		id: "new-pass-supersedes-old",
		subject: OLD_PROFILE,
		labels: [OLD_PASS, NEW_PASS],
		expectedState: "unavailable",
	},
	{
		id: "new-pass-visible",
		subject: NEW_PROFILE,
		labels: [OLD_PASS, NEW_PASS],
		expectedState: "passed",
	},
	{
		id: "manual-approval-pass-and-override",
		subject: NEW_PROFILE,
		labels: [
			OLD_PASS,
			NEW_PASS,
			label(LISTING_LABELS.overridden, "2026-08-24T00:00:05.000Z", {
				cid: FIXTURE_NEW_PROFILE_CID,
			}),
		],
		expectedState: "passed",
	},
	{
		id: "blocking-new-pass-does-not-revive-old",
		subject: OLD_PROFILE,
		labels: [OLD_PASS, NEW_PASS, NEGATE_NEW_PASS, NEW_BLOCK],
		expectedState: "unavailable",
	},
	{
		id: "exact-cid-block",
		subject: NEW_PROFILE,
		labels: [OLD_PASS, NEW_PASS, NEW_BLOCK],
		expectedState: "blocked",
	},
	{
		id: "conflicting-terminal-state",
		subject: OLD_PROFILE,
		labels: [
			OLD_PASS,
			label(LISTING_LABELS.review, "2026-08-24T00:00:02.000Z", {
				src: FIXTURE_STATE_DID,
			}),
		],
		expectedState: "conflict",
	},
	{
		id: "publisher-takedown",
		subject: OLD_PROFILE,
		labels: [
			OLD_PASS,
			label(LISTING_LABELS.takedown, "2026-08-24T00:00:02.000Z", {
				src: FIXTURE_REDACTION_DID,
				uri: FIXTURE_PUBLISHER_DID,
				cid: undefined,
			}),
		],
		expectedState: "takedown",
	},
	{
		id: "deleted",
		subject: { ...OLD_PROFILE, deleted: true },
		labels: [OLD_PASS],
		expectedState: "deleted",
	},
	{
		id: "tombstoned",
		subject: { ...OLD_PROFILE, tombstoned: true },
		labels: [OLD_PASS],
		expectedState: "tombstoned",
	},
] as const;

export const LABEL_TRANSITION_RULES_FIXTURE = [
	{
		actor: "automation",
		action: "start",
		issues: [LISTING_LABELS.pending],
		negatesForExactCid: [],
		preserves: [
			LISTING_LABELS.passed,
			LISTING_LABELS.blocked,
			LISTING_LABELS.overridden,
			LISTING_LABELS.takedown,
		],
	},
	{
		actor: "automation",
		action: "complete-pass",
		issues: [LISTING_LABELS.passed],
		negatesForExactCid: [LISTING_LABELS.pending, LISTING_LABELS.review, LISTING_LABELS.error],
		preserves: [LISTING_LABELS.blocked, LISTING_LABELS.overridden, LISTING_LABELS.takedown],
	},
	{
		actor: "automation",
		action: "complete-review",
		issues: [LISTING_LABELS.review],
		negatesForExactCid: [LISTING_LABELS.pending, LISTING_LABELS.passed, LISTING_LABELS.error],
		preserves: [LISTING_LABELS.blocked, LISTING_LABELS.overridden, LISTING_LABELS.takedown],
	},
	{
		actor: "automation",
		action: "complete-error",
		issues: [LISTING_LABELS.error],
		negatesForExactCid: [LISTING_LABELS.pending, LISTING_LABELS.passed, LISTING_LABELS.review],
		preserves: [LISTING_LABELS.blocked, LISTING_LABELS.overridden, LISTING_LABELS.takedown],
	},
	{
		actor: "reviewer",
		action: "approve",
		issues: [LISTING_LABELS.passed, LISTING_LABELS.overridden],
		negatesForExactCid: [LISTING_LABELS.review, LISTING_LABELS.error, LISTING_LABELS.blocked],
		preserves: [LISTING_LABELS.takedown],
	},
	{
		actor: "reviewer",
		action: "block",
		issues: [LISTING_LABELS.blocked],
		negatesForExactCid: [LISTING_LABELS.passed, LISTING_LABELS.overridden],
		preserves: [LISTING_LABELS.takedown],
	},
	{
		actor: "admin",
		action: "takedown",
		issues: [LISTING_LABELS.takedown],
		negatesForExactCid: [],
		preserves: [],
	},
	{
		actor: "admin",
		action: "retract-takedown",
		issues: [],
		negatesForExactCid: [],
		negatesForSubject: [LISTING_LABELS.takedown],
		preserves: [],
	},
] as const;
