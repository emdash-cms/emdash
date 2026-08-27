import {
	LISTING_LABELS,
	parseListingLabel,
	subjectKindFromUri,
	type ListingLabelEvent,
} from "@emdash-cms/registry-moderation";

import type {
	ListingLabelIssuanceContext,
	ListingLabelProposal,
	OperatorIssuanceContext,
} from "./types.js";

const DID =
	/^did:[a-z0-9]+:(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+(?::(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+)*$/;
const AUTOMATED_VALUES = new Set<string>([
	LISTING_LABELS.passed,
	LISTING_LABELS.pending,
	LISTING_LABELS.review,
	LISTING_LABELS.error,
]);

const OPERATOR_RULES: Readonly<
	Record<
		OperatorIssuanceContext["operatorAction"]["action"],
		{ positive: ReadonlySet<string>; negative: ReadonlySet<string> }
	>
> = {
	approve: {
		positive: new Set([LISTING_LABELS.passed, LISTING_LABELS.overridden]),
		negative: new Set([LISTING_LABELS.review, LISTING_LABELS.error, LISTING_LABELS.blocked]),
	},
	block: {
		positive: new Set([LISTING_LABELS.blocked]),
		negative: new Set([LISTING_LABELS.passed, LISTING_LABELS.overridden]),
	},
	takedown: {
		positive: new Set([LISTING_LABELS.takedown]),
		negative: new Set(),
	},
	"retract-takedown": {
		positive: new Set(),
		negative: new Set([LISTING_LABELS.takedown]),
	},
};

export interface ValidatedIssuance {
	label: Omit<ListingLabelEvent, "src">;
	subjectKind: "profile" | "release" | "publisher";
}

export function validateListingLabelIssuance(
	issuerDid: string,
	context: ListingLabelIssuanceContext,
	proposal: ListingLabelProposal,
	createdAt: Date,
): ValidatedIssuance {
	if (!DID.test(issuerDid)) throw new TypeError("issuerDid must be a valid DID");
	if (!DID.test(context.actorDid)) throw new TypeError("actorDid must be a valid DID");
	if (context.reason.trim().length === 0 || context.reason.length > 1_000) {
		throw new TypeError("reason must be between 1 and 1000 characters");
	}
	validateIdempotencyKey(context.idempotencyKey, "idempotencyKey");

	const negate = proposal.negate === true;
	let subjectKind: ValidatedIssuance["subjectKind"];
	if (proposal.value === LISTING_LABELS.takedown) {
		subjectKind = DID.test(proposal.subject.uri)
			? "publisher"
			: (subjectKindFromUri(proposal.subject.uri) ?? failInvalidSubject());
	} else {
		const parsedKind = subjectKindFromUri(proposal.subject.uri);
		if (parsedKind === null || parsedKind !== proposal.subject.kind) {
			throw new TypeError("subject URI collection must match subject kind");
		}
		subjectKind = parsedKind;
	}

	if (context.role === "automation") {
		if (context.actorDid !== issuerDid) {
			throw new TypeError("automation actor must be the label issuer");
		}
		if (context.assessmentId.length === 0 || context.assessmentId.length > 128) {
			throw new TypeError("assessmentId must be between 1 and 128 characters");
		}
		if (context.policyVersion.length === 0 || context.policyVersion.length > 128) {
			throw new TypeError("policyVersion must be between 1 and 128 characters");
		}
		if (!AUTOMATED_VALUES.has(proposal.value)) {
			throw new TypeError("automation cannot issue this label value");
		}
		if (proposal.negate !== true && proposal.value !== `listing-${context.outcome}`) {
			throw new TypeError("automated label value must match the assessment outcome");
		}
	} else {
		validateOperatorIssuance(context, proposal.value, negate);
	}

	const label = parseListingLabel({
		ver: 1,
		src: issuerDid,
		uri: proposal.subject.uri,
		...(proposal.value === LISTING_LABELS.takedown ? {} : { cid: proposal.subject.cid }),
		val: proposal.value,
		...(negate ? { neg: true } : {}),
		cts: createdAt.toISOString(),
		...(proposal.expiresAt === undefined ? {} : { exp: proposal.expiresAt }),
	});
	const { src: _source, ...unsigned } = label;
	return { label: unsigned, subjectKind };
}

function validateOperatorIssuance(
	context: OperatorIssuanceContext,
	value: string,
	negate: boolean,
): void {
	validateIdempotencyKey(context.operatorAction.idempotencyKey, "operatorAction.idempotencyKey");
	if (
		(context.operatorAction.action === "takedown" ||
			context.operatorAction.action === "retract-takedown") &&
		context.role !== "admin"
	) {
		throw new TypeError("only admins can issue or retract takedowns");
	}
	const rule = OPERATOR_RULES[context.operatorAction.action];
	if (!(negate ? rule.negative : rule.positive).has(value)) {
		throw new TypeError("label value and direction do not match the operator action");
	}
}

function validateIdempotencyKey(value: string, field: string): void {
	if (value.length === 0 || value.length > 200) {
		throw new TypeError(`${field} must be between 1 and 200 characters`);
	}
}

function failInvalidSubject(): never {
	throw new TypeError("takedown subject must be a publisher DID, profile URI, or release URI");
}
