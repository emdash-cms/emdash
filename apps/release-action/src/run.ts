import { readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

import { isDid } from "@atcute/lexicons/syntax";
import {
	ReleaseServiceClient,
	ReleaseServiceError,
	createReleaseIdempotencyKey,
	parseDelegatedReleaseSourceRecord,
	type DelegatedReleaseSourceRecord,
	type ReleaseIntentResource,
} from "@emdash-cms/registry-client/release-service";
import { NSID } from "@emdash-cms/registry-lexicons";

import {
	prepareReleaseFiles as defaultPrepareReleaseFiles,
	ReleasePreparationError,
	type PreparedReleaseFiles,
	type PrepareReleaseFilesOptions,
} from "./prepare.js";
import type { ActionRuntime } from "./runtime.js";

const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const MAX_RELEASE_FILE_BYTES = 128 * 1024;
const FAILURE_STATES = new Set([
	"invalid",
	"rejected",
	"cancelled",
	"expired",
	"failed",
	"conflict",
]);

export interface RunActionDependencies {
	fetch?: typeof fetch;
	readReleaseRecord?: (path: string, workspace: string) => Promise<unknown>;
	prepareReleaseFiles?: (options: PrepareReleaseFilesOptions) => Promise<PreparedReleaseFiles>;
}

export class ActionConfigurationError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ActionConfigurationError";
	}
}

function parsePositiveInteger(value: string, name: string, maximum: number): number {
	if (!POSITIVE_INTEGER_PATTERN.test(value)) {
		throw new ActionConfigurationError(`${name} must be a positive integer`);
	}
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed > maximum) {
		throw new ActionConfigurationError(`${name} is outside the supported range`);
	}
	return parsed;
}

function parseBoolean(value: string, name: string): boolean {
	if (value === "true") return true;
	if (value === "false") return false;
	throw new ActionConfigurationError(`${name} must be true or false`);
}

async function defaultReadReleaseRecord(path: string, workspace: string): Promise<unknown> {
	try {
		const workspacePath = await realpath(workspace);
		const candidate = await realpath(resolve(workspacePath, path));
		const relativePath = relative(workspacePath, candidate);
		if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
			throw new Error("outside workspace");
		}
		const metadata = await stat(candidate);
		if (!metadata.isFile() || metadata.size > MAX_RELEASE_FILE_BYTES) {
			throw new Error("invalid release file");
		}
		return JSON.parse(await readFile(candidate, "utf8"));
	} catch {
		throw new ActionConfigurationError("Release record file could not be read");
	}
}

function defaultIdempotencyKey(runtime: ActionRuntime): string {
	const runId = runtime.getEnvironment("GITHUB_RUN_ID");
	if (!runId || !POSITIVE_INTEGER_PATTERN.test(runId)) {
		throw new ActionConfigurationError("GitHub run identity is unavailable");
	}
	return `github-run-${runId}`;
}

async function setIntentOutputs(
	runtime: ActionRuntime,
	intent: ReleaseIntentResource,
): Promise<void> {
	await runtime.setOutput("intent-id", intent.id);
	await runtime.setOutput("state", intent.state);
	await runtime.setOutput("approval-url", intent.approvalUrl ?? "");
	await runtime.setOutput("release-uri", intent.result?.uri ?? "");
	await runtime.setOutput("release-cid", intent.result?.cid ?? "");
	await runtime.setOutput("reason-code", intent.reasonCode ?? "");
}

function sourceReleaseFromPrepared(
	prepared: PreparedReleaseFiles,
	packageUrl: string,
	provenanceUrl: string,
): DelegatedReleaseSourceRecord {
	const release = parseDelegatedReleaseSourceRecord({
		$type: NSID.packageRelease,
		package: prepared.packageSlug,
		version: prepared.version,
		artifacts: {
			package: {
				url: packageUrl,
				checksum: prepared.packageChecksum,
				contentType: "application/gzip",
			},
		},
		extensions: {
			[NSID.packageReleaseExtension]: {
				$type: NSID.packageReleaseExtension,
				declaredAccess: prepared.declaredAccess,
				provenance: {
					url: provenanceUrl,
					checksum: prepared.provenanceChecksum,
					predicateType: "https://slsa.dev/provenance/v1",
					sourceRepository: prepared.sourceRepository,
					builderId: prepared.builderId,
				},
			},
		},
	});
	if (!release) throw new ActionConfigurationError("Prepared release record is invalid");
	return release;
}

export async function runAction(
	runtime: ActionRuntime,
	dependencies: RunActionDependencies = {},
): Promise<ReleaseIntentResource> {
	const serviceUrl = runtime.getInput("service-url", { required: true });
	const publisherDid = runtime.getInput("publisher-did", { required: true });
	if (!isDid(publisherDid)) throw new ActionConfigurationError("publisher-did must be a valid DID");
	const workspace = runtime.getEnvironment("GITHUB_WORKSPACE");
	if (!workspace) throw new ActionConfigurationError("GitHub workspace is unavailable");
	const releaseFile = runtime.getInput("release-file");
	const bundleFile = runtime.getInput("bundle-file");
	const provenanceFile = runtime.getInput("provenance-file");
	let prepared: PreparedReleaseFiles | null = null;
	let release: DelegatedReleaseSourceRecord | null = null;
	if (releaseFile) {
		if (bundleFile || provenanceFile) {
			throw new ActionConfigurationError(
				"release-file cannot be combined with bundle-file or provenance-file",
			);
		}
		const rawRelease = await (dependencies.readReleaseRecord ?? defaultReadReleaseRecord)(
			releaseFile,
			workspace,
		);
		release = parseDelegatedReleaseSourceRecord(rawRelease);
		if (!release) throw new ActionConfigurationError("Release record file is invalid");
	} else {
		if (!provenanceFile) {
			throw new ActionConfigurationError(
				"provenance-file is required for project or bundle releases",
			);
		}
		const runnerTemp = runtime.getEnvironment("RUNNER_TEMP");
		const repository = runtime.getEnvironment("GITHUB_REPOSITORY");
		const workflowRef = runtime.getEnvironment("GITHUB_WORKFLOW_REF");
		const repositoryVisibility = runtime.getEnvironment("GITHUB_REPOSITORY_VISIBILITY");
		if (!runnerTemp || !repository || !workflowRef || !repositoryVisibility) {
			throw new ActionConfigurationError("GitHub workflow identity is unavailable");
		}
		prepared = await (dependencies.prepareReleaseFiles ?? defaultPrepareReleaseFiles)({
			workspace,
			runnerTemp,
			...(bundleFile ? { bundleFile } : {}),
			pluginDirectory: runtime.getInput("plugin-directory") || ".",
			provenanceFile,
			repository,
			workflowRef,
			repositoryVisibility,
		});
	}
	const packageSlug = prepared?.packageSlug ?? release!.package;
	const version = prepared?.version ?? release!.version;

	const configuredIdempotencyKey = runtime.getInput("idempotency-key");
	const idempotencyKey = configuredIdempotencyKey || defaultIdempotencyKey(runtime);
	const runId = runtime.getEnvironment("GITHUB_RUN_ID");
	if (!runId || !POSITIVE_INTEGER_PATTERN.test(runId)) {
		throw new ActionConfigurationError("GitHub run identity is unavailable");
	}
	const pollIntervalSeconds = parsePositiveInteger(
		runtime.getInput("poll-interval-seconds") || "5",
		"poll-interval-seconds",
		300,
	);
	const timeoutMinutes = parsePositiveInteger(
		runtime.getInput("timeout-minutes") || "30",
		"timeout-minutes",
		360,
	);
	const waitForApproval = parseBoolean(
		runtime.getInput("wait-for-approval") || "false",
		"wait-for-approval",
	);
	const connectionInvitation = runtime.getInput("connection-invitation");
	if (connectionInvitation) runtime.addMask(connectionInvitation);
	const client = new ReleaseServiceClient({
		serviceUrl,
		fetch: dependencies.fetch,
		workloadToken: async () => {
			const token = await runtime.getIDToken(serviceUrl);
			runtime.addMask(token);
			return token;
		},
	});
	await runtime.setOutput("connection-url", "");
	let connectionRequestId: string | null = null;
	await client.waitForWorkflowConnection(
		{
			publisherDid,
			packageSlug,
			...(connectionInvitation ? { invitationToken: connectionInvitation } : {}),
		},
		{
			idempotencyKey: `github-connection-${runId}-${packageSlug}`,
			pollIntervalMs: pollIntervalSeconds * 1000,
			maxWaitMs: timeoutMinutes * 60_000,
			onUpdate: async (current) => {
				if (current.status !== "pending" || current.request.id === connectionRequestId) return;
				connectionRequestId = current.request.id;
				await runtime.setOutput("connection-url", current.approvalUrl);
				runtime.info(`Approve this GitHub workflow to continue: ${current.approvalUrl}`);
				await runtime.writeSummary(
					`## Approve this GitHub workflow\n\n[Open EmDash to review and approve the workflow](${current.approvalUrl})`,
				);
			},
		},
	);
	if (prepared) {
		const packageUpload = await client.uploadReleaseArtifact(
			{
				publisherDid,
				packageSlug,
				version,
				slot: "package",
				checksum: prepared.packageChecksum,
				contentType: "application/gzip",
				bytes: prepared.packageBytes,
			},
			{ idempotencyKey: `github-upload-${runId}-${packageSlug}-package` },
		);
		const provenanceUpload = await client.uploadReleaseArtifact(
			{
				publisherDid,
				packageSlug,
				version,
				slot: "provenance",
				checksum: prepared.provenanceChecksum,
				contentType: "application/json",
				bytes: prepared.provenanceBytes,
			},
			{ idempotencyKey: `github-upload-${runId}-${packageSlug}-provenance` },
		);
		release = sourceReleaseFromPrepared(
			prepared,
			packageUpload.artifact.sourceUrl,
			provenanceUpload.artifact.sourceUrl,
		);
	}
	if (!release) throw new ActionConfigurationError("Release input is unavailable");
	const submitted = await client.submitIntent(
		{
			publisherDid,
			packageSlug,
			version,
			release,
		},
		{ idempotencyKey },
	);
	runtime.info(
		submitted.replayed
			? `Reusing release intent ${submitted.intent.id}`
			: `Submitted release intent ${submitted.intent.id}`,
	);
	let previousState = submitted.intent.state;
	const intent = await client.waitForIntent(publisherDid, submitted.intent.id, {
		pollIntervalMs: pollIntervalSeconds * 1000,
		maxWaitMs: timeoutMinutes * 60_000,
		stopOnApproval: !waitForApproval,
		onUpdate: (current) => {
			if (current.state !== previousState) {
				previousState = current.state;
				runtime.info(`Release intent ${current.id} entered ${current.state}`);
			}
		},
	});
	await setIntentOutputs(runtime, intent);
	if (intent.state === "awaiting_approval") {
		runtime.info(`Release intent ${intent.id} requires approval: ${intent.approvalUrl}`);
		return intent;
	}
	if (intent.state === "published" && intent.result) {
		runtime.info(`Published ${intent.result.uri} (${intent.result.cid})`);
		return intent;
	}
	if (FAILURE_STATES.has(intent.state)) {
		throw new ActionConfigurationError(
			`Release intent ended in ${intent.state}${intent.reasonCode ? ` (${intent.reasonCode})` : ""}`,
		);
	}
	throw new ActionConfigurationError(`Release intent stopped in unexpected state ${intent.state}`);
}

export async function executeAction(
	runtime: ActionRuntime,
	dependencies: RunActionDependencies = {},
) {
	try {
		await runAction(runtime, dependencies);
	} catch (error) {
		if (
			error instanceof ReleaseServiceError ||
			error instanceof ActionConfigurationError ||
			error instanceof ReleasePreparationError
		) {
			runtime.setFailed(
				error instanceof ReleaseServiceError ? `${error.code}: ${error.message}` : error.message,
			);
			return;
		}
		runtime.setFailed("Delegated release failed");
	}
}

export { createReleaseIdempotencyKey };
