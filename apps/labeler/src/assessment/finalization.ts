import type { ListingLabelProposal } from "../labels/types.js";
import type { AssessmentPolicyResolution } from "./policy.js";
import type { AssessmentRunSnapshot } from "./types.js";

export interface AssessmentFinalizationProposal {
	schemaVersion: 1;
	runKey: string;
	assessmentId: string;
	expectedStateVersion: number;
	subject: AssessmentRunSnapshot["subject"];
	moderationFingerprint: string;
	policyVersion: string;
	outcome: "passed" | "review" | "error";
	resolution: AssessmentPolicyResolution;
	label: ListingLabelProposal;
	idempotencyKey: string;
	reason: string;
}

export interface AssessmentFinalizationCommit {
	run: AssessmentRunSnapshot;
	labelSequence?: number;
	publicationPending: boolean;
}

export interface AssessmentFinalizationIssuer {
	commitAssessmentFinalization(
		proposal: AssessmentFinalizationProposal,
		now?: Date,
	): Promise<AssessmentFinalizationCommit>;
}

export function createAssessmentFinalizationProposal(input: {
	run: AssessmentRunSnapshot;
	moderationFingerprint: string;
	resolution: AssessmentPolicyResolution;
}): AssessmentFinalizationProposal {
	if (input.run.state !== "running") {
		throw new TypeError("only a running assessment can be finalized");
	}
	if (!input.moderationFingerprint) {
		throw new TypeError("assessment finalization requires its moderation fingerprint");
	}
	const outcome = input.resolution.outcome === "pass" ? "passed" : input.resolution.outcome;
	const value =
		outcome === "passed"
			? ("listing-passed" as const)
			: outcome === "review"
				? ("listing-review" as const)
				: ("listing-error" as const);
	return {
		schemaVersion: 1,
		runKey: input.run.runKey,
		assessmentId: input.run.runKey,
		expectedStateVersion: input.run.stateVersion,
		subject: input.run.subject,
		moderationFingerprint: input.moderationFingerprint,
		policyVersion: input.resolution.policyVersion,
		outcome,
		resolution: input.resolution,
		label: { subject: input.run.subject, value },
		idempotencyKey: `assessment:${input.run.runKey}:final:${outcome}:${input.moderationFingerprint}`,
		reason: `Automated metadata assessment resolved as ${outcome}.`,
	};
}

export async function finalizeResolvedAssessment(
	issuer: AssessmentFinalizationIssuer,
	proposal: AssessmentFinalizationProposal,
	now?: Date,
): Promise<AssessmentFinalizationCommit> {
	assertFinalizationProposal(proposal);
	const committed = await issuer.commitAssessmentFinalization(proposal, now);
	if (
		committed.run.runKey !== proposal.runKey ||
		committed.run.subject.uri !== proposal.subject.uri ||
		committed.run.subject.cid !== proposal.subject.cid ||
		committed.run.state !== proposal.outcome
	) {
		throw new Error("assessment finalization issuer returned a mismatched commit");
	}
	return committed;
}

export function assertFinalizationProposal(proposal: AssessmentFinalizationProposal): void {
	if (proposal.schemaVersion !== 1) throw new TypeError("finalization schemaVersion must be 1");
	if (
		proposal.runKey !== proposal.assessmentId ||
		proposal.runKey.length === 0 ||
		proposal.expectedStateVersion < 0 ||
		!Number.isSafeInteger(proposal.expectedStateVersion)
	) {
		throw new TypeError("finalization assessment binding is invalid");
	}
	if (
		proposal.label.value !== "listing-passed" &&
		proposal.label.value !== "listing-review" &&
		proposal.label.value !== "listing-error"
	) {
		throw new TypeError("finalization label value is not an automated outcome");
	}
	if (!("cid" in proposal.label.subject) || proposal.label.subject.cid !== proposal.subject.cid) {
		throw new TypeError("finalization label must target the exact assessment CID");
	}
	if (proposal.label.subject.uri !== proposal.subject.uri) {
		throw new TypeError("finalization label must target the exact assessment URI");
	}
	const expectedLabel =
		proposal.outcome === "passed"
			? "listing-passed"
			: proposal.outcome === "review"
				? "listing-review"
				: "listing-error";
	if (proposal.label.value !== expectedLabel) {
		throw new TypeError("finalization outcome and label do not agree");
	}
	const expectedOutcome = proposal.outcome === "passed" ? "pass" : proposal.outcome;
	if (
		proposal.resolution.outcome !== expectedOutcome ||
		proposal.resolution.policyVersion !== proposal.policyVersion
	) {
		throw new TypeError("finalization resolution does not agree with its outcome and policy");
	}
}
