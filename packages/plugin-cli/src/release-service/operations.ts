import { readFile, stat } from "node:fs/promises";

import { safeParse } from "@atcute/lexicons";
import {
	ReleaseServiceClient,
	createReleaseIdempotencyKey,
	type ReleaseIntentResource,
} from "@emdash-cms/registry-client/release-service";
import { PackageRelease } from "@emdash-cms/registry-lexicons";

const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
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
	onUpdate?: (intent: ReleaseIntentResource) => void | Promise<void>;
}

export interface MutateReleaseIntentOptions extends ReleaseServiceTarget {
	intentId: string;
	idempotencyKey?: string;
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
	const runAttempt = environment["GITHUB_RUN_ATTEMPT"];
	if (
		runId &&
		runAttempt &&
		POSITIVE_INTEGER_PATTERN.test(runId) &&
		POSITIVE_INTEGER_PATTERN.test(runAttempt)
	) {
		return `github-run-${runId}-attempt-${runAttempt}`;
	}
	return createReleaseIdempotencyKey("emdash-plugin-release");
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
	const release = safeParse(PackageRelease.mainSchema, rawRelease);
	if (!release.ok) throw new Error("Release record file is invalid");
	const environment = dependencies.environment ?? process.env;
	const client = releaseClient(options, dependencies);
	const submitted = await client.submitIntent(
		{
			publisherDid: options.publisherDid,
			packageSlug: release.value.package,
			version: release.value.version,
			release: release.value,
		},
		{ idempotencyKey: options.idempotencyKey ?? defaultIdempotencyKey(environment) },
	);
	if (options.wait === false) return submitted.intent;
	return await client.waitForIntent(options.publisherDid, submitted.intent.id, {
		pollIntervalMs: options.pollIntervalMs,
		maxWaitMs: options.maxWaitMs,
		stopOnApproval: !(options.waitForApproval ?? false),
		onUpdate: options.onUpdate,
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
