import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { base64url } from "jose";

import type { AccessActor } from "../access/auth.js";
import { loadConfiguration, type ServiceConfiguration } from "../config.js";
import { SERVICE_CONTROL_OBJECT_NAME } from "../control-do/service-control-do.js";
import { EncryptionError } from "../crypto/encryption.js";
import type { DirectoryIdentityKind } from "../directory/identity-directory-do.js";

const ACTOR_IDENTITY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,255}$/;
const CAMPAIGN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const MAX_KEY_VERSION = 2_147_483_647;
const DIRECTORY_PAGE_SIZE = 25;
const MAX_DIRECTORY_PAGES = 400;
const DIRECTORY_SHARDS_PER_STEP = 16;
const MAX_ROTATION_PASSES = 5;
const REQUIRED_ZERO_CHANGE_PASSES = 2;
const STEP_CONFIG = {
	retries: { limit: 5, delay: "2 seconds", backoff: "exponential" },
	timeout: "5 minutes",
} as const;

export interface EncryptionVerificationWorkflowParams {
	campaignId: string;
	targetKeyVersion: number;
	retiringKeyVersion: number | null;
	actorIdentity: string;
}

export interface EncryptionVerificationWorkflowOutput {
	targetKeyVersion: number;
	retiringKeyVersion: number | null;
	publishers: number;
	approvers: number;
	records: number;
	rotated: number;
	verifiedAt: number;
}

export type StartEncryptionVerificationWorkflowResult =
	| { ok: true; workflowId: string; created: boolean }
	| { ok: false; code: "ENCRYPTION_WORKFLOW_UNAVAILABLE" };

interface ShardVerificationResult {
	identities: number;
	records: number;
	rotated: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validKeyVersion(value: unknown): value is number {
	return Number.isSafeInteger(value) && Number(value) >= 1 && Number(value) <= MAX_KEY_VERSION;
}

function validParams(value: unknown): value is EncryptionVerificationWorkflowParams {
	return (
		isRecord(value) &&
		typeof value["campaignId"] === "string" &&
		CAMPAIGN_ID_PATTERN.test(value["campaignId"]) &&
		validKeyVersion(value["targetKeyVersion"]) &&
		(value["retiringKeyVersion"] === null ||
			(validKeyVersion(value["retiringKeyVersion"]) &&
				Number(value["retiringKeyVersion"]) < Number(value["targetKeyVersion"]))) &&
		typeof value["actorIdentity"] === "string" &&
		ACTOR_IDENTITY_PATTERN.test(value["actorIdentity"])
	);
}

async function workflowId(params: EncryptionVerificationWorkflowParams): Promise<string> {
	return base64url.encode(
		new Uint8Array(
			await crypto.subtle.digest(
				"SHA-256",
				new TextEncoder().encode(
					JSON.stringify([
						"encryption-verification-workflow",
						1,
						params.campaignId,
						params.targetKeyVersion,
						params.retiringKeyVersion,
					]),
				),
			),
		),
	);
}

export async function startEncryptionVerificationWorkflow(
	workflow: Workflow<EncryptionVerificationWorkflowParams>,
	params: EncryptionVerificationWorkflowParams,
): Promise<StartEncryptionVerificationWorkflowResult> {
	if (!validParams(params)) return { ok: false, code: "ENCRYPTION_WORKFLOW_UNAVAILABLE" };
	const id = await workflowId(params);
	try {
		await workflow.create({ id, params });
		return { ok: true, workflowId: id, created: true };
	} catch {
		try {
			const existing = await workflow.get(id);
			const status = await existing.status();
			if (status.status === "unknown") {
				return { ok: false, code: "ENCRYPTION_WORKFLOW_UNAVAILABLE" };
			}
			if (status.status === "errored" || status.status === "terminated") {
				await existing.restart();
			}
			return { ok: true, workflowId: id, created: false };
		} catch {
			return { ok: false, code: "ENCRYPTION_WORKFLOW_UNAVAILABLE" };
		}
	}
}

function assertConfiguration(
	configuration: ServiceConfiguration,
	params: EncryptionVerificationWorkflowParams,
): void {
	if (
		configuration.encryption.currentKeyVersion !== params.targetKeyVersion ||
		!configuration.encryption.availableKeyVersions.includes(params.targetKeyVersion) ||
		(params.retiringKeyVersion !== null &&
			!configuration.encryption.availableKeyVersions.includes(params.retiringKeyVersion))
	) {
		throw new NonRetryableError("Encryption verification keyring changed");
	}
}

async function verifyOwner(
	env: Env,
	configuration: ServiceConfiguration,
	kind: DirectoryIdentityKind,
	did: string,
	actorIdentity: string,
): Promise<{ records: number; rotated: number }> {
	let totalRotated = 0;
	let recordCount = 0;
	let consecutiveZeroChangePasses = 0;
	for (let pass = 0; pass < MAX_ROTATION_PASSES; pass += 1) {
		const page =
			kind === "publisher"
				? await env.PUBLISHER_DO.getByName(did).listEncryptionRecords(did, null, 100)
				: await env.APPROVER_DO.getByName(did).listEncryptionRecords(did, null, 100);
		if (page.nextCursor !== null) {
			throw new NonRetryableError("Encryption shard exceeds the bounded record page");
		}
		recordCount = page.items.length;
		let changed = 0;
		let raced = 0;
		for (const record of page.items) {
			let replacement;
			try {
				replacement = await configuration.encryption.rotate(record.envelope, record.context);
			} catch (error) {
				if (error instanceof EncryptionError) {
					throw new NonRetryableError("Retained ciphertext could not be verified");
				}
				throw error;
			}
			if (
				replacement.envelope === record.envelope &&
				replacement.keyVersion === record.keyVersion
			) {
				continue;
			}
			const replaced =
				kind === "publisher"
					? await env.PUBLISHER_DO.getByName(did).replaceEncryptionRecord({
							publisherDid: did,
							cursor: record.cursor,
							expectedEnvelope: record.envelope,
							replacementEnvelope: replacement.envelope,
							replacementKeyVersion: replacement.keyVersion,
							actorIdentity,
						})
					: await env.APPROVER_DO.getByName(did).replaceEncryptionRecord({
							approverDid: did,
							cursor: record.cursor,
							expectedEnvelope: record.envelope,
							replacementEnvelope: replacement.envelope,
							replacementKeyVersion: replacement.keyVersion,
							actorIdentity,
						});
			if (replaced) changed += 1;
			else raced += 1;
		}
		totalRotated += changed;
		consecutiveZeroChangePasses =
			changed === 0 && raced === 0 ? consecutiveZeroChangePasses + 1 : 0;
		if (consecutiveZeroChangePasses >= REQUIRED_ZERO_CHANGE_PASSES) {
			return { records: recordCount, rotated: totalRotated };
		}
	}
	throw new Error("Encryption shard did not reach a stable verified state");
}

async function verifyDirectoryShard(
	env: Env,
	configuration: ServiceConfiguration,
	params: EncryptionVerificationWorkflowParams,
	kind: DirectoryIdentityKind,
	shard: string,
): Promise<ShardVerificationResult> {
	const directory = env.IDENTITY_DIRECTORY_DO.getByName(shard);
	let afterDid: string | null = null;
	let identities = 0;
	let records = 0;
	let rotated = 0;
	for (let pageNumber = 0; pageNumber < MAX_DIRECTORY_PAGES; pageNumber += 1) {
		const page = await directory.list(kind, afterDid, DIRECTORY_PAGE_SIZE);
		const results = await Promise.all(
			page.map((identity) =>
				verifyOwner(env, configuration, kind, identity.did, params.actorIdentity),
			),
		);
		identities += page.length;
		for (const result of results) {
			records += result.records;
			rotated += result.rotated;
		}
		if (page.length < DIRECTORY_PAGE_SIZE) return { identities, records, rotated };
		afterDid = page.at(-1)!.did;
	}
	throw new NonRetryableError("Encryption verification directory shard exceeds its page limit");
}

async function verifyDirectoryGroup(
	env: Env,
	params: EncryptionVerificationWorkflowParams,
	kind: DirectoryIdentityKind,
	group: number,
): Promise<ShardVerificationResult> {
	const configuration = await loadConfiguration(env);
	assertConfiguration(configuration, params);
	let identities = 0;
	let records = 0;
	let rotated = 0;
	const firstShard = group * DIRECTORY_SHARDS_PER_STEP;
	for (
		let shardNumber = firstShard;
		shardNumber < firstShard + DIRECTORY_SHARDS_PER_STEP;
		shardNumber += 1
	) {
		const result = await verifyDirectoryShard(
			env,
			configuration,
			params,
			kind,
			shardNumber.toString(16).padStart(2, "0"),
		);
		identities += result.identities;
		records += result.records;
		rotated += result.rotated;
	}
	return { identities, records, rotated };
}

export class EncryptionVerificationWorkflow extends WorkflowEntrypoint<
	Env,
	EncryptionVerificationWorkflowParams
> {
	override async run(
		event: Readonly<WorkflowEvent<EncryptionVerificationWorkflowParams>>,
		step: WorkflowStep,
	): Promise<EncryptionVerificationWorkflowOutput> {
		if (!validParams(event.payload)) {
			throw new NonRetryableError("Invalid encryption-verification Workflow parameters");
		}
		const params = event.payload;
		const actor: AccessActor = {
			realm: "access",
			identity: params.actorIdentity,
			email: "encryption-workflow@emdash.invalid",
			role: "admin",
		};
		await step.do("validate-encryption-campaign", STEP_CONFIG, async () => {
			const configuration = await loadConfiguration(this.env);
			assertConfiguration(configuration, params);
			const control = this.env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME);
			const [state, keys] = await Promise.all([
				control.readServiceState(actor),
				control.readEncryptionKeys(actor),
			]);
			if (
				state.mode !== "publication-paused" ||
				keys.find((key) => key.status === "active")?.version !== params.targetKeyVersion ||
				(params.retiringKeyVersion !== null &&
					keys.find((key) => key.version === params.retiringKeyVersion)?.status !== "readable")
			) {
				throw new NonRetryableError("Encryption campaign control state is invalid");
			}
		});
		let publishers = 0;
		let approvers = 0;
		let records = 0;
		let rotated = 0;
		for (const kind of ["publisher", "approver"] as const) {
			for (let group = 0; group < 256 / DIRECTORY_SHARDS_PER_STEP; group += 1) {
				const result = await step.do<ShardVerificationResult>(
					`encryption-${kind}-${group.toString(16).padStart(2, "0")}`,
					STEP_CONFIG,
					() => verifyDirectoryGroup(this.env, params, kind, group),
				);
				if (kind === "publisher") publishers += result.identities;
				else approvers += result.identities;
				records += result.records;
				rotated += result.rotated;
			}
		}
		const id = await workflowId(params);
		const verification = await step.do<{ verifiedAt: number }>(
			"record-encryption-verification",
			STEP_CONFIG,
			async () => {
				const recorded = await this.env.SERVICE_CONTROL_DO.getByName(
					SERVICE_CONTROL_OBJECT_NAME,
				).recordEncryptionVerification({
					targetKeyVersion: params.targetKeyVersion,
					workflowId: id,
					actorIdentity: "release-service",
					publishers,
					approvers,
					records,
					rotated,
					verifiedAt: Date.now(),
				});
				return { verifiedAt: recorded.verifiedAt };
			},
		);
		return {
			targetKeyVersion: params.targetKeyVersion,
			retiringKeyVersion: params.retiringKeyVersion,
			publishers,
			approvers,
			records,
			rotated,
			verifiedAt: verification.verifiedAt,
		};
	}
}
