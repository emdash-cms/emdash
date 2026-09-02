import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey, type JWTPayload } from "jose";

import { WorkloadIdentityError, type VerifiedWorkloadIdentity } from "./types.js";

export const GITHUB_ACTIONS_ISSUER = "https://token.actions.githubusercontent.com";
const GITHUB_ACTIONS_JWKS = `${GITHUB_ACTIONS_ISSUER}/.well-known/jwks`;
const GITHUB_JWKS_CACHE_SYMBOL = Symbol.for("@emdash-cms/release-service/github-oidc-jwks");
const MAX_TOKEN_CHARS = 16 * 1024;
const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ACTOR_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})|[A-Za-z0-9-]{1,39}\[bot\])$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const REF_PATTERN = /^refs\/[A-Za-z0-9._/-]{1,507}$/;
const WORKFLOW_REF_PATTERN =
	/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml@refs\/[A-Za-z0-9._/-]+$/;

function getGitHubJwks(): JWTVerifyGetKey {
	const target = globalThis as typeof globalThis & {
		[GITHUB_JWKS_CACHE_SYMBOL]?: JWTVerifyGetKey;
	};
	return (target[GITHUB_JWKS_CACHE_SYMBOL] ??= createRemoteJWKSet(new URL(GITHUB_ACTIONS_JWKS)));
}

function requiredString(
	payload: JWTPayload,
	claim: string,
	maximum: number,
	pattern?: RegExp,
): string {
	const value = payload[claim];
	if (
		typeof value !== "string" ||
		value.length === 0 ||
		value.length > maximum ||
		(pattern && !pattern.test(value))
	) {
		throw new WorkloadIdentityError("WORKLOAD_TOKEN_INVALID");
	}
	return value;
}

function optionalString(payload: JWTPayload, claim: string, maximum: number): string | null {
	const value = payload[claim];
	if (value === undefined) return null;
	if (typeof value !== "string" || value.length === 0 || value.length > maximum) {
		throw new WorkloadIdentityError("WORKLOAD_TOKEN_INVALID");
	}
	return value;
}

function normalizeClaims(payload: JWTPayload): VerifiedWorkloadIdentity {
	const subject = requiredString(payload, "sub", 2048);
	const tokenId = requiredString(payload, "jti", 255);
	const repository = requiredString(payload, "repository", 256, REPOSITORY_PATTERN);
	const repositoryId = requiredString(payload, "repository_id", 32, DECIMAL_ID_PATTERN);
	const repositoryOwner = requiredString(payload, "repository_owner", 64, LOGIN_PATTERN);
	const repositoryOwnerId = requiredString(payload, "repository_owner_id", 32, DECIMAL_ID_PATTERN);
	const workflowRef = requiredString(payload, "workflow_ref", 1024, WORKFLOW_REF_PATTERN);
	const workflowSha = requiredString(payload, "workflow_sha", 40, SHA_PATTERN);
	const jobRef = optionalString(payload, "job_workflow_ref", 1024);
	const jobSha = optionalString(payload, "job_workflow_sha", 40);
	const runId = requiredString(payload, "run_id", 32, DECIMAL_ID_PATTERN);
	const runAttemptValue = requiredString(payload, "run_attempt", 10, DECIMAL_ID_PATTERN);
	const actor = requiredString(payload, "actor", 64, ACTOR_PATTERN);
	const actorId = requiredString(payload, "actor_id", 32, DECIMAL_ID_PATTERN);
	const eventName = requiredString(payload, "event_name", 128);
	const ref = requiredString(payload, "ref", 512, REF_PATTERN);
	const refType = requiredString(payload, "ref_type", 16);
	const commitSha = requiredString(payload, "sha", 40, SHA_PATTERN);
	const environment = optionalString(payload, "environment", 255);
	const visibility = requiredString(payload, "repository_visibility", 16);
	const runnerEnvironment = requiredString(payload, "runner_environment", 32);
	const runAttempt = Number(runAttemptValue);
	const issuedAt = payload.iat;
	const expiresAt = payload.exp;
	const [owner] = repository.split("/", 1);
	if (
		owner?.toLowerCase() !== repositoryOwner.toLowerCase() ||
		!workflowRef.toLowerCase().startsWith(`${repository.toLowerCase()}/.github/workflows/`) ||
		(jobRef === null) !== (jobSha === null) ||
		(jobRef !== null && !WORKFLOW_REF_PATTERN.test(jobRef)) ||
		(jobSha !== null && !SHA_PATTERN.test(jobSha)) ||
		!Number.isSafeInteger(runAttempt) ||
		runAttempt < 1 ||
		(refType !== "branch" && refType !== "tag") ||
		(visibility !== "public" && visibility !== "private" && visibility !== "internal") ||
		(runnerEnvironment !== "github-hosted" && runnerEnvironment !== "self-hosted") ||
		typeof issuedAt !== "number" ||
		!Number.isSafeInteger(issuedAt) ||
		typeof expiresAt !== "number" ||
		!Number.isSafeInteger(expiresAt) ||
		issuedAt > expiresAt
	) {
		throw new WorkloadIdentityError("WORKLOAD_TOKEN_INVALID");
	}
	return {
		issuer: "github-actions",
		subject,
		tokenId,
		repository: {
			name: repository.toLowerCase(),
			id: repositoryId,
			owner: repositoryOwner.toLowerCase(),
			ownerId: repositoryOwnerId,
			visibility,
		},
		workflow: { ref: workflowRef, sha: workflowSha, jobRef, jobSha },
		run: {
			id: runId,
			attempt: runAttempt,
			actor,
			actorId,
			eventName,
			ref,
			refType,
			commitSha,
			environment,
			runnerEnvironment,
		},
		issuedAt,
		expiresAt,
	};
}

export async function verifyGitHubActionsToken(
	token: string,
	expectedAudience: string,
	keyResolver: JWTVerifyGetKey = getGitHubJwks(),
): Promise<VerifiedWorkloadIdentity> {
	let validAudience = false;
	try {
		const audienceUrl = new URL(expectedAudience);
		validAudience = audienceUrl.protocol === "https:" && audienceUrl.origin === expectedAudience;
	} catch {
		validAudience = false;
	}
	if (
		typeof token !== "string" ||
		token.length === 0 ||
		token.length > MAX_TOKEN_CHARS ||
		!validAudience
	) {
		throw new WorkloadIdentityError(
			validAudience ? "WORKLOAD_TOKEN_INVALID" : "WORKLOAD_CONFIGURATION_INVALID",
		);
	}
	try {
		const { payload } = await jwtVerify(token, keyResolver, {
			algorithms: ["RS256"],
			audience: expectedAudience,
			issuer: GITHUB_ACTIONS_ISSUER,
			typ: "JWT",
			clockTolerance: 5,
			maxTokenAge: "10 minutes",
			requiredClaims: [
				"exp",
				"iat",
				"nbf",
				"jti",
				"sub",
				"repository",
				"repository_id",
				"repository_owner",
				"repository_owner_id",
				"workflow_ref",
				"workflow_sha",
				"run_id",
				"run_attempt",
				"actor",
				"actor_id",
				"event_name",
				"ref",
				"ref_type",
				"sha",
				"repository_visibility",
				"runner_environment",
			],
		});
		return normalizeClaims(payload);
	} catch (error) {
		if (error instanceof WorkloadIdentityError) throw error;
		throw new WorkloadIdentityError("WORKLOAD_TOKEN_INVALID");
	}
}
