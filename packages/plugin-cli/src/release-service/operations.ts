import { readFile, stat } from "node:fs/promises";

import {
	ReleaseServiceClient,
	createReleaseIdempotencyKey,
	parseDelegatedReleaseSourceRecord,
	type DryRunReleaseIntentResult,
	type ReleaseIntentResource,
	type RequestWorkflowConnectionResult,
} from "@emdash-cms/registry-client/release-service";

const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const MAX_RELEASE_FILE_BYTES = 128 * 1024;
const MAX_OIDC_TOKEN_CHARS = 16 * 1024;

export interface ReleaseServiceEnvironment {
	readonly [key: string]: string | undefined;
}

export interface ReleaseServiceOperationDependencies {
	fetch?: typeof fetch;
	environment?: ReleaseServiceEnvironment;
	readReleaseRecord?: (path: string) => Promise<unknown>;
}

export interface ReleaseServiceTarget {
	serviceUrl: string;
	publisherDid: string;
}

export interface SubmitDelegatedReleaseOptions extends ReleaseServiceTarget {
	releaseFile: string;
	idempotencyKey?: string;
	wait?: boolean;
	waitForApproval?: boolean;
	pollIntervalMs?: number;
	maxWaitMs?: number;
	onConnectionUpdate?: (result: RequestWorkflowConnectionResult) => void | Promise<void>;
	onUpdate?: (intent: ReleaseIntentResource) => void | Promise<void>;
}

export interface DryRunDelegatedReleaseOptions extends ReleaseServiceTarget {
	releaseFile: string;
}

export interface MutateReleaseIntentOptions extends ReleaseServiceTarget {
	intentId: string;
	idempotencyKey?: string;
}

export type InteractiveReleaseAction =
	| "approve"
	| "delegate"
	| "enrol"
	| "reject"
	| "revoke"
	| "workload";

export interface InteractiveReleaseOptions {
	serviceUrl: string;
	publisherDid?: string;
	intentId?: string;
}

export function interactiveReleaseUrl(
	action: InteractiveReleaseAction,
	options: InteractiveReleaseOptions,
): URL {
	let service: URL;
	try {
		service = new URL(options.serviceUrl);
	} catch {
		throw new Error("Release service URL must be a secure origin");
	}
	const loopback =
		service.hostname === "localhost" ||
		service.hostname === "127.0.0.1" ||
		service.hostname === "[::1]";
	if (
		(service.protocol !== "https:" && !(service.protocol === "http:" && loopback)) ||
		service.username !== "" ||
		service.password !== "" ||
		service.pathname !== "/" ||
		service.search !== "" ||
		service.hash !== ""
	) {
		throw new Error("Release service URL must be a secure origin");
	}
	if (action === "delegate" || action === "revoke" || action === "workload") {
		service.pathname = "/publisher";
		service.searchParams.set("view", action === "workload" ? "workloads" : "delegation");
		if (action === "revoke") service.searchParams.set("action", "revoke");
		return service;
	}
	if (action === "enrol") {
		service.pathname = "/approver";
		return service;
	}
	if (
		!options.intentId ||
		!ULID_PATTERN.test(options.intentId) ||
		!options.publisherDid ||
		!DID_PATTERN.test(options.publisherDid)
	) {
		throw new Error("Approval browser handoff requires a publisher DID and intent ULID");
	}
	service.pathname = `/approvals/${options.intentId}`;
	service.searchParams.set("publisher", options.publisherDid);
	service.searchParams.set("decision", action);
	return service;
}

async function defaultReadReleaseRecord(path: string): Promise<unknown> {
	try {
		const metadata = await stat(path);
		if (!metadata.isFile() || metadata.size > MAX_RELEASE_FILE_BYTES) {
			throw new Error("invalid release file");
		}
		return JSON.parse(await readFile(path, "utf8"));
	} catch {
		throw new Error("Release record file could not be read");
	}
}

function defaultIdempotencyKey(environment: ReleaseServiceEnvironment): string {
	const runId = environment["GITHUB_RUN_ID"];
	if (runId && POSITIVE_INTEGER_PATTERN.test(runId)) {
		return `github-run-${runId}`;
	}
	return createReleaseIdempotencyKey("emdash-plugin-release");
}

function defaultConnectionIdempotencyKey(
	environment: ReleaseServiceEnvironment,
	packageSlug: string,
): string {
	const runId = environment["GITHUB_RUN_ID"];
	if (runId && POSITIVE_INTEGER_PATTERN.test(runId)) {
		return `github-connection-${runId}-${packageSlug}`;
	}
	return createReleaseIdempotencyKey("workflow-connection");
}

export async function requestGithubOidcToken(
	audience: string,
	dependencies: ReleaseServiceOperationDependencies = {},
): Promise<string> {
	const environment = dependencies.environment ?? process.env;
	const requestUrl = environment["ACTIONS_ID_TOKEN_REQUEST_URL"];
	const requestToken = environment["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
	if (!requestUrl || !requestToken) {
		throw new Error("GitHub Actions OIDC is unavailable");
	}
	let url: URL;
	try {
		url = new URL(requestUrl);
		if (url.protocol !== "https:" || url.username !== "" || url.password !== "") {
			throw new Error("invalid OIDC URL");
		}
		url.searchParams.set("audience", audience);
	} catch {
		throw new Error("GitHub Actions OIDC is unavailable");
	}
	const response = await (dependencies.fetch ?? globalThis.fetch)(url, {
		headers: { authorization: `Bearer ${requestToken}` },
		signal: AbortSignal.timeout(30_000),
	});
	if (!response.ok) throw new Error("GitHub Actions OIDC request failed");
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new Error("GitHub Actions OIDC response is invalid");
	}
	if (
		payload === null ||
		typeof payload !== "object" ||
		Array.isArray(payload) ||
		!("value" in payload) ||
		typeof payload.value !== "string" ||
		payload.value.length === 0 ||
		payload.value.length > MAX_OIDC_TOKEN_CHARS
	) {
		throw new Error("GitHub Actions OIDC response is invalid");
	}
	return payload.value;
}

function releaseClient(
	target: ReleaseServiceTarget,
	dependencies: ReleaseServiceOperationDependencies,
): ReleaseServiceClient {
	return new ReleaseServiceClient({
		serviceUrl: target.serviceUrl,
		fetch: dependencies.fetch,
		workloadToken: () => requestGithubOidcToken(target.serviceUrl, dependencies),
	});
}

export async function submitDelegatedRelease(
	options: SubmitDelegatedReleaseOptions,
	dependencies: ReleaseServiceOperationDependencies = {},
): Promise<ReleaseIntentResource> {
	const rawRelease = await (dependencies.readReleaseRecord ?? defaultReadReleaseRecord)(
		options.releaseFile,
	);
	const release = parseDelegatedReleaseSourceRecord(rawRelease);
	if (!release) throw new Error("Release record file is invalid");
	const environment = dependencies.environment ?? process.env;
	const client = releaseClient(options, dependencies);
	await client.waitForWorkflowConnection(
		{
			publisherDid: options.publisherDid,
			packageSlug: release.package,
			...(environment["EMDASH_CONNECTION_INVITATION"]
				? { invitationToken: environment["EMDASH_CONNECTION_INVITATION"] }
				: {}),
		},
		{
			idempotencyKey: defaultConnectionIdempotencyKey(environment, release.package),
			pollIntervalMs: options.pollIntervalMs,
			maxWaitMs: options.maxWaitMs,
			onUpdate: options.onConnectionUpdate,
		},
	);
	const idempotencyKey = options.idempotencyKey ?? defaultIdempotencyKey(environment);
	const submitted = await client.submitIntent(
		{
			publisherDid: options.publisherDid,
			packageSlug: release.package,
			version: release.version,
			release,
		},
		{ idempotencyKey },
	);
	if (options.wait === false) return submitted.intent;
	return await client.waitForIntent(options.publisherDid, submitted.intent.id, {
		pollIntervalMs: options.pollIntervalMs,
		maxWaitMs: options.maxWaitMs,
		stopOnApproval: !(options.waitForApproval ?? false),
		onUpdate: options.onUpdate,
	});
}

export async function dryRunDelegatedRelease(
	options: DryRunDelegatedReleaseOptions,
	dependencies: ReleaseServiceOperationDependencies = {},
): Promise<DryRunReleaseIntentResult> {
	const rawRelease = await (dependencies.readReleaseRecord ?? defaultReadReleaseRecord)(
		options.releaseFile,
	);
	const release = parseDelegatedReleaseSourceRecord(rawRelease);
	if (!release) throw new Error("Release record file is invalid");
	return await releaseClient(options, dependencies).dryRunIntent({
		publisherDid: options.publisherDid,
		packageSlug: release.package,
		version: release.version,
		release,
	});
}

export async function getDelegatedReleaseIntent(
	options: ReleaseServiceTarget & { intentId: string },
	dependencies: ReleaseServiceOperationDependencies = {},
): Promise<ReleaseIntentResource> {
	return await releaseClient(options, dependencies).getIntent(
		options.publisherDid,
		options.intentId,
	);
}

export async function cancelDelegatedReleaseIntent(
	options: MutateReleaseIntentOptions,
	dependencies: ReleaseServiceOperationDependencies = {},
): Promise<ReleaseIntentResource> {
	const environment = dependencies.environment ?? process.env;
	return await releaseClient(options, dependencies).cancelIntent(
		options.publisherDid,
		options.intentId,
		{
			idempotencyKey: options.idempotencyKey ?? defaultIdempotencyKey(environment),
		},
	);
}
