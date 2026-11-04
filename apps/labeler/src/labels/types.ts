import type {
	ListingLabelValue,
	ListingSubjectKind,
	SignedListingLabel,
} from "@emdash-cms/registry-moderation";

export type LabelActorRole = "automation" | "reviewer" | "admin";

export type OperatorLabelAction = "approve" | "block" | "takedown" | "retract-takedown";

export interface ExactListingSubject {
	kind: ListingSubjectKind;
	uri: string;
	cid: string;
}

export interface ExactListingLabelProposal {
	subject: ExactListingSubject;
	value: Exclude<ListingLabelValue, "!takedown">;
	negate?: boolean;
	expiresAt?: string;
}

export interface TakedownLabelProposal {
	subject: { uri: string };
	value: "!takedown";
	negate?: boolean;
	expiresAt?: string;
}

export type ListingLabelProposal = ExactListingLabelProposal | TakedownLabelProposal;

interface BaseIssuanceContext {
	actorDid: string;
	reason: string;
	idempotencyKey: string;
}

export interface AutomatedIssuanceContext extends BaseIssuanceContext {
	role: "automation";
	assessmentId: string;
	policyVersion: string;
	outcome: "pending" | "passed" | "review" | "error";
}

export interface OperatorIssuanceContext extends BaseIssuanceContext {
	role: "reviewer" | "admin";
	operatorAction: {
		action: OperatorLabelAction;
		idempotencyKey: string;
	};
}

export type ListingLabelIssuanceContext = AutomatedIssuanceContext | OperatorIssuanceContext;

export interface OperatorDecisionContext {
	actorDid: string;
	role: "reviewer" | "admin";
	reason: string;
	idempotencyKey: string;
}

export interface IssuedListingDecision {
	action: "approve" | "block";
	operatorActionId: number;
	labels: readonly IssuedListingLabel[];
}

export interface IssuedListingLabel {
	label: SignedListingLabel;
	sequence: number;
	idempotencyKey: string;
	actorDid: string;
	actorRole: LabelActorRole;
	reason: string;
	assessmentId?: string;
	assessmentPolicyVersion?: string;
	assessmentOutcome?: AutomatedIssuanceContext["outcome"];
	operatorActionId?: number;
	operatorAction?: {
		action: OperatorLabelAction;
		idempotencyKey: string;
	};
	signingKeyId: string;
	publicationPending: boolean;
}

export interface LabelPublicationTarget {
	notify(sequence: number): Promise<void>;
}
