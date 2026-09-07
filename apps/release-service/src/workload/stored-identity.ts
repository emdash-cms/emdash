import { digestWorkloadIdentity } from "./policy.js";
import type { VerifiedWorkloadIdentity } from "./types.js";

const DECIMAL_ID_PATTERN = /^[1-9][0-9]*$/;
const REPOSITORY_PATTERN = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/;
const LOGIN_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,38})$/;
const ACTOR_PATTERN = /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})|[A-Za-z0-9-]{1,39}\[bot\])$/;
const SHA_PATTERN = /^[a-f0-9]{40}$/;
const REF_PATTERN = /^refs\/[A-Za-z0-9._/-]{1,507}$/;
const WORKFLOW_REF_PATTERN =
	/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml@refs\/[A-Za-z0-9._/-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function boundedString(value: unknown, maximum: number, pattern?: RegExp): string | null {
	return typeof value === "string" &&
		value.length > 0 &&
		value.length <= maximum &&
		(!pattern || pattern.test(value))
		? value
		: null;
}

function nullableString(
	value: unknown,
	maximum: number,
	pattern?: RegExp,
): string | null | undefined {
	return value === null ? null : (boundedString(value, maximum, pattern) ?? undefined);
}

function safeInteger(value: unknown, minimum = 0): number | null {
	return Number.isSafeInteger(value) && Number(value) >= minimum ? Number(value) : null;
}

function parseIdentity(value: unknown): VerifiedWorkloadIdentity | null {
	if (
		!isRecord(value) ||
		!isRecord(value["repository"]) ||
		!isRecord(value["workflow"]) ||
		!isRecord(value["run"])
	) {
		return null;
	}
	const repository = value["repository"];
	const workflow = value["workflow"];
	const run = value["run"];
	const subject = boundedString(value["subject"], 2048);
	const tokenId = boundedString(value["tokenId"], 255);
	const repositoryName = boundedString(repository["name"], 256, REPOSITORY_PATTERN);
	const repositoryId = boundedString(repository["id"], 32, DECIMAL_ID_PATTERN);
	const repositoryOwner = boundedString(repository["owner"], 64, LOGIN_PATTERN);
	const repositoryOwnerId = boundedString(repository["ownerId"], 32, DECIMAL_ID_PATTERN);
	const workflowRef = boundedString(workflow["ref"], 1024, WORKFLOW_REF_PATTERN);
	const workflowSha = boundedString(workflow["sha"], 40, SHA_PATTERN);
	const jobRef = nullableString(workflow["jobRef"], 1024, WORKFLOW_REF_PATTERN);
	const jobSha = nullableString(workflow["jobSha"], 40, SHA_PATTERN);
	const runId = boundedString(run["id"], 32, DECIMAL_ID_PATTERN);
	const runAttempt = safeInteger(run["attempt"], 1);
	const actor = boundedString(run["actor"], 64, ACTOR_PATTERN);
	const actorId = boundedString(run["actorId"], 32, DECIMAL_ID_PATTERN);
	const eventName = boundedString(run["eventName"], 128);
	const ref = boundedString(run["ref"], 512, REF_PATTERN);
	const commitSha = boundedString(run["commitSha"], 40, SHA_PATTERN);
	const environment = nullableString(run["environment"], 255);
	const issuedAt = safeInteger(value["issuedAt"]);
	const expiresAt = safeInteger(value["expiresAt"]);
	if (
		value["issuer"] !== "github-actions" ||
		!subject ||
		!tokenId ||
		!repositoryName ||
		!repositoryId ||
		!repositoryOwner ||
		!repositoryOwnerId ||
		(repository["visibility"] !== "public" &&
			repository["visibility"] !== "private" &&
			repository["visibility"] !== "internal") ||
		!workflowRef ||
		!workflowSha ||
		jobRef === undefined ||
		jobSha === undefined ||
		(jobRef === null) !== (jobSha === null) ||
		!runId ||
		runAttempt === null ||
		!actor ||
		!actorId ||
		!eventName ||
		!ref ||
		(run["refType"] !== "branch" && run["refType"] !== "tag") ||
		!commitSha ||
		environment === undefined ||
		(run["runnerEnvironment"] !== "github-hosted" && run["runnerEnvironment"] !== "self-hosted") ||
		issuedAt === null ||
		expiresAt === null ||
		issuedAt > expiresAt ||
		repositoryOwner !== repositoryName.split("/", 1)[0] ||
		!workflowRef.toLowerCase().startsWith(`${repositoryName}/.github/workflows/`)
	) {
		return null;
	}
	return {
		issuer: "github-actions",
		subject,
		tokenId,
		repository: {
			name: repositoryName,
			id: repositoryId,
			owner: repositoryOwner,
			ownerId: repositoryOwnerId,
			visibility: repository["visibility"],
		},
		workflow: { ref: workflowRef, sha: workflowSha, jobRef, jobSha },
		run: {
			id: runId,
			attempt: runAttempt,
			actor,
			actorId,
			eventName,
			ref,
			refType: run["refType"],
			commitSha,
			environment,
			runnerEnvironment: run["runnerEnvironment"],
		},
		issuedAt,
		expiresAt,
	};
}

export async function parseStoredWorkloadIdentity(
	json: string,
	expectedDigest: string,
): Promise<VerifiedWorkloadIdentity | null> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(json);
	} catch {
		return null;
	}
	const identity = parseIdentity(parsed);
	if (!identity || JSON.stringify(identity) !== json) return null;
	return (await digestWorkloadIdentity(identity)) === expectedDigest ? identity : null;
}
