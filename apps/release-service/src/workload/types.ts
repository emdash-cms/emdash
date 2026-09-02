export type WorkloadIdentityErrorCode = "WORKLOAD_CONFIGURATION_INVALID" | "WORKLOAD_TOKEN_INVALID";

export class WorkloadIdentityError extends Error {
	readonly code: WorkloadIdentityErrorCode;

	constructor(code: WorkloadIdentityErrorCode) {
		super(code);
		this.name = "WorkloadIdentityError";
		this.code = code;
	}
}

export interface VerifiedWorkloadIdentity {
	issuer: "github-actions";
	subject: string;
	tokenId: string;
	repository: {
		name: string;
		id: string;
		owner: string;
		ownerId: string;
		visibility: "public" | "private" | "internal";
	};
	workflow: {
		ref: string;
		sha: string;
		jobRef: string | null;
		jobSha: string | null;
	};
	run: {
		id: string;
		attempt: number;
		actor: string;
		actorId: string;
		eventName: string;
		ref: string;
		refType: "branch" | "tag";
		commitSha: string;
		environment: string | null;
		runnerEnvironment: "github-hosted" | "self-hosted";
	};
	issuedAt: number;
	expiresAt: number;
}

const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const LOGIN_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const ACTOR_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})|[A-Za-z0-9-]{1,39}\[bot\])$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const REF_PATTERN = /^refs\/[A-Za-z0-9._/-]{1,507}$/;
const WORKFLOW_REF_PATTERN =
	/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml@refs\/[A-Za-z0-9._/-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
	const keys = Object.keys(value);
	return keys.length === expected.length && keys.every((key) => expected.includes(key));
}

export function parseStoredWorkloadIdentity(value: string): VerifiedWorkloadIdentity | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	if (
		!isRecord(parsed) ||
		!hasExactKeys(parsed, [
			"issuer",
			"subject",
			"tokenId",
			"repository",
			"workflow",
			"run",
			"issuedAt",
			"expiresAt",
		]) ||
		parsed.issuer !== "github-actions" ||
		typeof parsed.subject !== "string" ||
		parsed.subject.length === 0 ||
		parsed.subject.length > 2048 ||
		typeof parsed.tokenId !== "string" ||
		parsed.tokenId.length === 0 ||
		parsed.tokenId.length > 255 ||
		!isRecord(parsed.repository) ||
		!hasExactKeys(parsed.repository, ["name", "id", "owner", "ownerId", "visibility"]) ||
		!isRecord(parsed.workflow) ||
		!hasExactKeys(parsed.workflow, ["ref", "sha", "jobRef", "jobSha"]) ||
		!isRecord(parsed.run) ||
		!hasExactKeys(parsed.run, [
			"id",
			"attempt",
			"actor",
			"actorId",
			"eventName",
			"ref",
			"refType",
			"commitSha",
			"environment",
			"runnerEnvironment",
		])
	) {
		return null;
	}
	const repository = parsed.repository;
	const workflow = parsed.workflow;
	const run = parsed.run;
	if (
		typeof repository.name !== "string" ||
		!REPOSITORY_PATTERN.test(repository.name) ||
		repository.name !== repository.name.toLowerCase() ||
		typeof repository.id !== "string" ||
		!DECIMAL_ID_PATTERN.test(repository.id) ||
		typeof repository.owner !== "string" ||
		!LOGIN_PATTERN.test(repository.owner) ||
		repository.owner !== repository.owner.toLowerCase() ||
		typeof repository.ownerId !== "string" ||
		!DECIMAL_ID_PATTERN.test(repository.ownerId) ||
		(repository.visibility !== "public" &&
			repository.visibility !== "private" &&
			repository.visibility !== "internal") ||
		typeof workflow.ref !== "string" ||
		workflow.ref.length > 1024 ||
		!WORKFLOW_REF_PATTERN.test(workflow.ref) ||
		typeof workflow.sha !== "string" ||
		!SHA_PATTERN.test(workflow.sha) ||
		(workflow.jobRef !== null &&
			(typeof workflow.jobRef !== "string" ||
				workflow.jobRef.length > 1024 ||
				!WORKFLOW_REF_PATTERN.test(workflow.jobRef))) ||
		(workflow.jobSha !== null &&
			(typeof workflow.jobSha !== "string" || !SHA_PATTERN.test(workflow.jobSha))) ||
		(workflow.jobRef === null) !== (workflow.jobSha === null) ||
		typeof run.id !== "string" ||
		!DECIMAL_ID_PATTERN.test(run.id) ||
		typeof run.attempt !== "number" ||
		!Number.isSafeInteger(run.attempt) ||
		run.attempt < 1 ||
		typeof run.actor !== "string" ||
		!ACTOR_PATTERN.test(run.actor) ||
		typeof run.actorId !== "string" ||
		!DECIMAL_ID_PATTERN.test(run.actorId) ||
		typeof run.eventName !== "string" ||
		run.eventName.length === 0 ||
		run.eventName.length > 128 ||
		typeof run.ref !== "string" ||
		!REF_PATTERN.test(run.ref) ||
		(run.refType !== "branch" && run.refType !== "tag") ||
		typeof run.commitSha !== "string" ||
		!SHA_PATTERN.test(run.commitSha) ||
		(run.environment !== null &&
			(typeof run.environment !== "string" ||
				run.environment.length === 0 ||
				run.environment.length > 255)) ||
		(run.runnerEnvironment !== "github-hosted" && run.runnerEnvironment !== "self-hosted") ||
		typeof parsed.issuedAt !== "number" ||
		!Number.isSafeInteger(parsed.issuedAt) ||
		typeof parsed.expiresAt !== "number" ||
		!Number.isSafeInteger(parsed.expiresAt) ||
		parsed.issuedAt > parsed.expiresAt ||
		repository.name.split("/", 1)[0] !== repository.owner ||
		!workflow.ref.toLowerCase().startsWith(`${repository.name}/.github/workflows/`)
	) {
		return null;
	}
	const identity: VerifiedWorkloadIdentity = {
		issuer: "github-actions",
		subject: parsed.subject,
		tokenId: parsed.tokenId,
		repository: {
			name: repository.name,
			id: repository.id,
			owner: repository.owner,
			ownerId: repository.ownerId,
			visibility: repository.visibility,
		},
		workflow: {
			ref: workflow.ref,
			sha: workflow.sha,
			jobRef: workflow.jobRef,
			jobSha: workflow.jobSha,
		},
		run: {
			id: run.id,
			attempt: run.attempt,
			actor: run.actor,
			actorId: run.actorId,
			eventName: run.eventName,
			ref: run.ref,
			refType: run.refType,
			commitSha: run.commitSha,
			environment: run.environment,
			runnerEnvironment: run.runnerEnvironment,
		},
		issuedAt: parsed.issuedAt,
		expiresAt: parsed.expiresAt,
	};
	return JSON.stringify(identity) === value ? identity : null;
}
