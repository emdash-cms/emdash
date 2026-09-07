import { createRequire } from "node:module";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { MigrationExecutorFactoryContext, MigrationTarget } from "emdash/migrations";

import { readBoundedJson } from "./d1-rest-dialect.js";

const ACCOUNT_ID_PATTERN = /^[a-f0-9]{32}$/i;
const DATABASE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const DATABASE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const BINDING_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const NIL_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
const MAX_DATABASE_ID = "ffffffff-ffff-ffff-ffff-ffffffffffff";
const CONTROL_PLANE_TIMEOUT_MS = 15_000;
const CONTROL_PLANE_MAX_BYTES = 1_048_576;
const DATABASE_LIST_PAGE_SIZE = 100;
const MAX_DATABASE_LIST_PAGES = 1000;

export interface D1MigrationManifestConfig {
	binding: string;
}

export interface WranglerD1Database {
	binding: string;
	databaseName?: string;
	databaseId?: string;
	previewDatabaseId?: string;
}

export interface WranglerMigrationConfig {
	accountId?: string;
	d1Databases: WranglerD1Database[];
}

export interface ResolvedD1MigrationTarget {
	target: MigrationTarget;
	accountId: string;
	databaseId: string;
	databaseName: string;
}

export interface D1TargetResolutionDependencies {
	fetch?: typeof globalThis.fetch;
	readWranglerConfig?: typeof loadProjectWranglerConfig;
}

interface WranglerModule {
	unstable_readConfig?: (
		args: { config: string; env?: string },
		options: { hideWarnings: boolean },
	) => unknown;
}

interface MetadataEnvelope {
	result: unknown;
	resultInfo?: unknown;
}

interface ListResultInfo {
	page: number;
	perPage: number;
	count: number;
	totalCount: number;
	totalPages: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function canonicalAccountId(value: unknown): string {
	if (typeof value !== "string" || !ACCOUNT_ID_PATTERN.test(value)) {
		throw new Error("A valid Cloudflare account ID is required for D1 migrations.");
	}
	const id = value.toLowerCase();
	if (id === "0".repeat(32) || id === "f".repeat(32)) {
		throw new Error("A valid Cloudflare account ID is required for D1 migrations.");
	}
	return id;
}

function canonicalDatabaseId(value: unknown): string {
	if (typeof value !== "string" || !DATABASE_ID_PATTERN.test(value)) {
		throw new Error("A valid production D1 database UUID is required.");
	}
	const id = value.toLowerCase();
	if (id === NIL_DATABASE_ID || id === MAX_DATABASE_ID) {
		throw new Error("A valid production D1 database UUID is required.");
	}
	return id;
}

function databaseName(value: unknown): string {
	if (typeof value !== "string" || !DATABASE_NAME_PATTERN.test(value)) {
		throw new Error("A valid D1 database name is required.");
	}
	return value;
}

function apiMessages(value: unknown): string[] {
	if (!Array.isArray(value)) throw new Error("Cloudflare D1 metadata response is invalid.");
	return value.map((item) => {
		if (!isRecord(item) || typeof item.message !== "string") {
			throw new Error("Cloudflare D1 metadata response is invalid.");
		}
		return item.message;
	});
}

function validateApiEnvelope(value: unknown): MetadataEnvelope {
	if (!isRecord(value)) throw new Error("Cloudflare D1 metadata response is invalid.");
	const errors = apiMessages(value.errors);
	apiMessages(value.messages);
	if (value.success !== true) {
		throw new Error(
			errors.length > 0
				? `Cloudflare D1 metadata request failed: ${errors.join("; ")}`
				: "Cloudflare D1 metadata request failed.",
		);
	}
	if (errors.length !== 0 || !("result" in value)) {
		throw new Error("Cloudflare D1 metadata response is invalid.");
	}
	return { result: value.result, resultInfo: value.result_info };
}

async function metadataRequest(
	path: string,
	token: string,
	fetch: typeof globalThis.fetch,
): Promise<MetadataEnvelope> {
	const controller = new AbortController();
	const timer = setTimeout(controller.abort.bind(controller), CONTROL_PLANE_TIMEOUT_MS);
	try {
		const response = await fetch(`https://api.cloudflare.com/client/v4${path}`, {
			headers: { authorization: `Bearer ${token}` },
			redirect: "error",
			signal: controller.signal,
		});
		if (!response.ok) {
			throw new Error(`Cloudflare D1 metadata request failed with HTTP status ${response.status}.`);
		}
		return validateApiEnvelope(await readBoundedJson(response, CONTROL_PLANE_MAX_BYTES));
	} catch (error) {
		if (error instanceof Error && !error.message.includes(token)) throw error;
		// eslint-disable-next-line preserve-caught-error -- the cause may contain the authorization token or request details
		throw new Error("Cloudflare D1 metadata request failed.");
	} finally {
		clearTimeout(timer);
	}
}

function metadataDatabase(value: unknown): { uuid: string; name: string } {
	if (!isRecord(value)) throw new Error("Cloudflare D1 database metadata is invalid.");
	if (value.version !== "production") {
		throw new Error("Preview D1 databases cannot be used for deployment migrations.");
	}
	return {
		uuid: canonicalDatabaseId(value.uuid),
		name: databaseName(value.name),
	};
}

async function databaseById(
	accountId: string,
	databaseId: string,
	token: string,
	fetch: typeof globalThis.fetch,
): Promise<{ uuid: string; name: string }> {
	const metadata = metadataDatabase(
		(
			await metadataRequest(
				`/accounts/${encodeURIComponent(accountId)}/d1/database/${encodeURIComponent(databaseId)}`,
				token,
				fetch,
			)
		).result,
	);
	if (metadata.uuid !== databaseId)
		throw new Error("Cloudflare returned a different D1 database UUID.");
	return metadata;
}

async function databaseByName(
	accountId: string,
	name: string,
	token: string,
	fetch: typeof globalThis.fetch,
): Promise<{ uuid: string; name: string }> {
	const matches: Array<{ uuid: string; name: string }> = [];
	let page = 1;
	let totalPages = 1;
	let totalCount: number | undefined;
	let seenCount = 0;
	while (page <= totalPages) {
		const envelope = await metadataRequest(
			`/accounts/${encodeURIComponent(accountId)}/d1/database?name=${encodeURIComponent(name)}&page=${page}&per_page=${DATABASE_LIST_PAGE_SIZE}`,
			token,
			fetch,
		);
		if (!Array.isArray(envelope.result)) {
			throw new Error("Cloudflare D1 database list is invalid.");
		}
		const resultInfo = listResultInfo(envelope.resultInfo, page, envelope.result.length);
		if (totalCount === undefined) {
			totalCount = resultInfo.totalCount;
			totalPages = resultInfo.totalPages;
		} else if (resultInfo.totalCount !== totalCount || resultInfo.totalPages !== totalPages) {
			throw new Error("Cloudflare D1 database list pagination is invalid.");
		}
		if (totalPages > MAX_DATABASE_LIST_PAGES) {
			throw new Error("Cloudflare D1 database list pagination is invalid.");
		}
		seenCount += resultInfo.count;
		matches.push(
			...envelope.result.map(metadataDatabase).filter((database) => database.name === name),
		);
		page += 1;
	}
	if (seenCount !== totalCount) {
		throw new Error("Cloudflare D1 database list pagination is invalid.");
	}
	if (matches.length !== 1) {
		throw new Error(
			matches.length === 0
				? `No D1 database named ${name} exists in the selected account.`
				: `More than one D1 database named ${name} exists in the selected account.`,
		);
	}
	return matches[0]!;
}

function listInteger(value: unknown, name: string, minimum: number): number {
	if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) {
		throw new Error(`Cloudflare D1 database list ${name} is invalid.`);
	}
	return value;
}

function listResultInfo(value: unknown, expectedPage: number, resultCount: number): ListResultInfo {
	if (!isRecord(value)) throw new Error("Cloudflare D1 database list pagination is invalid.");
	const result = {
		page: listInteger(value.page, "page", 1),
		perPage: listInteger(value.per_page, "per_page", 1),
		count: listInteger(value.count, "count", 0),
		totalCount: listInteger(value.total_count, "total_count", 0),
		totalPages: listInteger(value.total_pages, "total_pages", 0),
	};
	if (
		result.page !== expectedPage ||
		result.perPage > DATABASE_LIST_PAGE_SIZE ||
		result.count !== resultCount ||
		result.totalCount < result.count ||
		(result.totalPages === 0
			? result.totalCount !== 0 || expectedPage !== 1
			: expectedPage > result.totalPages)
	) {
		throw new Error("Cloudflare D1 database list pagination is invalid.");
	}
	return result;
}

async function fingerprintTarget(accountId: string, databaseId: string): Promise<string> {
	const input = new TextEncoder().encode(
		JSON.stringify({ kind: "d1", identity: [accountId, databaseId] }),
	);
	const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", input));
	return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function loadProjectWranglerConfig(
	configPath: string,
	environment: string | undefined,
	projectRoot: string,
): Promise<WranglerMigrationConfig> {
	const require = createRequire(join(projectRoot, "package.json"));
	let entrypoint: string;
	try {
		entrypoint = require.resolve("wrangler");
	} catch {
		throw new Error("D1 target resolution requires Wrangler to be installed in the project.");
	}
	const loaded: unknown = await import(pathToFileURL(entrypoint).href);
	if (!isRecord(loaded)) throw new Error("The project Wrangler module is invalid.");
	const readConfig = (loaded as WranglerModule).unstable_readConfig;
	if (typeof readConfig !== "function") {
		throw new Error("The project Wrangler version does not expose its configuration reader.");
	}
	const config = await readConfig(
		{ config: configPath, ...(environment ? { env: environment } : {}) },
		{ hideWarnings: true },
	);
	if (!isRecord(config) || !Array.isArray(config.d1_databases)) {
		throw new Error("The selected Wrangler configuration is invalid.");
	}
	return {
		accountId: typeof config.account_id === "string" ? config.account_id : undefined,
		d1Databases: config.d1_databases.map((binding) => {
			if (!isRecord(binding) || typeof binding.binding !== "string") {
				throw new Error("The selected Wrangler D1 binding is invalid.");
			}
			return {
				binding: binding.binding,
				databaseName: typeof binding.database_name === "string" ? binding.database_name : undefined,
				databaseId: typeof binding.database_id === "string" ? binding.database_id : undefined,
				previewDatabaseId:
					typeof binding.preview_database_id === "string" ? binding.preview_database_id : undefined,
			};
		}),
	};
}

export async function resolveD1MigrationTarget(
	manifestConfig: D1MigrationManifestConfig,
	context: MigrationExecutorFactoryContext,
	dependencies: D1TargetResolutionDependencies = {},
): Promise<ResolvedD1MigrationTarget> {
	if (!isRecord(manifestConfig) || !BINDING_PATTERN.test(manifestConfig.binding)) {
		throw new Error("The D1 migration binding is invalid.");
	}
	const configOverride = context.overrides?.wranglerConfig;
	const environmentOverride = context.overrides?.wranglerEnv;
	if (environmentOverride && !configOverride) {
		throw new Error("A Wrangler environment requires an explicit Wrangler configuration path.");
	}
	const readWranglerConfig = dependencies.readWranglerConfig ?? loadProjectWranglerConfig;
	let wranglerConfig: WranglerMigrationConfig | undefined;
	if (configOverride) {
		const configPath = isAbsolute(configOverride)
			? configOverride
			: resolve(context.projectRoot, configOverride);
		wranglerConfig = await readWranglerConfig(configPath, environmentOverride, context.projectRoot);
	}

	const explicitAccountId = context.overrides?.accountId;
	if (
		explicitAccountId &&
		wranglerConfig?.accountId &&
		canonicalAccountId(explicitAccountId) !== canonicalAccountId(wranglerConfig.accountId)
	) {
		throw new Error("The explicit and Wrangler Cloudflare account IDs conflict.");
	}
	const accountId = canonicalAccountId(
		explicitAccountId ?? wranglerConfig?.accountId ?? context.env.CLOUDFLARE_ACCOUNT_ID,
	);
	const token = context.env.CLOUDFLARE_API_TOKEN;
	if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required for D1 migrations.");
	const fetch = dependencies.fetch ?? globalThis.fetch;
	const selector = context.overrides?.d1;
	let metadata: { uuid: string; name: string };

	if (selector) {
		if (DATABASE_ID_PATTERN.test(selector)) {
			metadata = await databaseById(accountId, canonicalDatabaseId(selector), token, fetch);
		} else {
			metadata = await databaseByName(accountId, databaseName(selector), token, fetch);
		}
	} else {
		if (!wranglerConfig) {
			throw new Error("D1 migrations require an explicit database selector or Wrangler config.");
		}
		const bindings = wranglerConfig.d1Databases.filter(
			(binding) => binding.binding === manifestConfig.binding,
		);
		if (bindings.length !== 1) {
			throw new Error(
				`Wrangler must contain exactly one D1 binding named ${manifestConfig.binding}.`,
			);
		}
		const binding = bindings[0]!;
		if (binding.previewDatabaseId !== undefined) {
			throw new Error("Preview D1 database IDs cannot be used for deployment migrations.");
		}
		const configuredId = canonicalDatabaseId(binding.databaseId);
		const configuredName = databaseName(binding.databaseName);
		metadata = await databaseById(accountId, configuredId, token, fetch);
		if (metadata.name !== configuredName) {
			throw new Error("Wrangler D1 database metadata does not match the selected remote database.");
		}
	}

	const environment = configOverride ? environmentOverride || "top-level" : undefined;
	const target = Object.freeze({
		kind: "d1",
		label: `${accountId}/${metadata.name}/${metadata.uuid}`,
		fingerprint: await fingerprintTarget(accountId, metadata.uuid),
		accountId,
		resourceId: metadata.uuid,
		...(environment ? { environment } : {}),
	});
	return Object.freeze({
		target,
		accountId,
		databaseId: metadata.uuid,
		databaseName: metadata.name,
	});
}
