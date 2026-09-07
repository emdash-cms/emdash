import { base64url } from "jose";

import {
	refRuleMatches,
	type StoredWorkloadPolicy,
	workflowRefRuleMatches,
} from "../publisher-do/workload-policy.js";
import type { VerifiedWorkloadIdentity } from "./types.js";

export type WorkloadPolicyRejectionCode =
	| "WORKLOAD_POLICY_INACTIVE"
	| "WORKLOAD_REPOSITORY_MISMATCH"
	| "WORKLOAD_WORKFLOW_MISMATCH"
	| "WORKLOAD_REF_MISMATCH"
	| "WORKLOAD_ENVIRONMENT_MISMATCH";

export type WorkloadPolicyDecision =
	| { ok: true }
	| { ok: false; code: WorkloadPolicyRejectionCode };

export function evaluateWorkloadPolicy(
	identity: VerifiedWorkloadIdentity,
	policy: StoredWorkloadPolicy,
): WorkloadPolicyDecision {
	if (!policy.active) return { ok: false, code: "WORKLOAD_POLICY_INACTIVE" };
	if (
		identity.repository.name !== policy.repository ||
		identity.repository.id !== policy.repositoryId ||
		identity.repository.ownerId !== policy.repositoryOwnerId
	) {
		return { ok: false, code: "WORKLOAD_REPOSITORY_MISMATCH" };
	}
	if (!workflowRefRuleMatches(policy.workflowRef, identity.workflow.ref)) {
		return { ok: false, code: "WORKLOAD_WORKFLOW_MISMATCH" };
	}
	if (
		policy.allowedRefs.length > 0 &&
		!policy.allowedRefs.some((rule) => refRuleMatches(rule, identity.run.ref))
	) {
		return { ok: false, code: "WORKLOAD_REF_MISMATCH" };
	}
	if (
		policy.allowedEnvironments.length > 0 &&
		(identity.run.environment === null ||
			!policy.allowedEnvironments.includes(identity.run.environment))
	) {
		return { ok: false, code: "WORKLOAD_ENVIRONMENT_MISMATCH" };
	}
	return { ok: true };
}

async function digest(parts: readonly unknown[]): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(parts));
	return base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

export function digestWorkloadIdentity(identity: VerifiedWorkloadIdentity): Promise<string> {
	return digest([
		"emdash-release-service",
		"workload-identity",
		1,
		identity.issuer,
		identity.subject,
		identity.tokenId,
		identity.repository.name,
		identity.repository.id,
		identity.repository.owner,
		identity.repository.ownerId,
		identity.repository.visibility,
		identity.workflow.ref,
		identity.workflow.sha,
		identity.workflow.jobRef,
		identity.workflow.jobSha,
		identity.run.id,
		identity.run.attempt,
		identity.run.actor,
		identity.run.actorId,
		identity.run.eventName,
		identity.run.ref,
		identity.run.refType,
		identity.run.commitSha,
		identity.run.environment,
		identity.run.runnerEnvironment,
		identity.issuedAt,
		identity.expiresAt,
	]);
}

export function digestWorkloadIdempotencyIdentity(
	identity: VerifiedWorkloadIdentity,
	publisherDid: string,
	packageSlug: string,
	version: string,
): Promise<string> {
	return digest([
		"emdash-release-service",
		"workload-idempotency",
		1,
		publisherDid,
		packageSlug,
		version,
		identity.issuer,
		identity.repository.id,
		identity.repository.ownerId,
		identity.workflow.ref,
		identity.run.id,
	]);
}
