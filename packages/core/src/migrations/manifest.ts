import { z } from "zod";

import type { CoreMigrationIdentity } from "./identity.js";
import { fingerprintMigrationSet } from "./identity.js";

const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/;
const MIGRATION_NAME_PATTERN = /^\d{3}_[a-z0-9_]+$/;
const EXECUTOR_ENTRYPOINT_PATTERN =
	/^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*(?:\/[A-Za-z0-9][A-Za-z0-9._-]*)*$/;
const ENVIRONMENT_VARIABLE_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const ENVIRONMENT_REFERENCE_KEY_PATTERN = /(?:env|envName|envVar)$/i;
const URL_SCHEME_PATTERN = /^[A-Za-z][A-Za-z0-9+.-]*:/;
const SECRET_QUERY_KEY_PATTERN = /(?:auth|credential|key|password|secret|signature|token)/i;
const SECRET_CONFIG_KEY_PATTERN =
	/(?:accessToken|apiKey|authToken|certificate|connectionString|password|privateKey|secret)/i;
const SECRET_CONFIG_EXACT_KEY_PATTERN = /^(?:ca|cert|key)$/i;
const CONNECTION_URL_PROTOCOLS = new Set(["mysql:", "postgres:", "postgresql:"]);

type JsonPrimitive = boolean | number | string | null;
type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

const i18nConfigSchema = z
	.object({
		defaultLocale: z.string().min(1),
		locales: z.array(z.string().min(1)).min(1),
		fallback: z.record(z.string(), z.string()).optional(),
		prefixDefaultLocale: z.boolean().optional(),
	})
	.strict();

export const migrationManifestV1Schema = z
	.object({
		schemaVersion: z.literal(1),
		emdashVersion: z.string().min(1),
		migrationSet: z
			.object({
				names: z
					.array(z.string().regex(MIGRATION_NAME_PATTERN))
					.min(1)
					.refine((names) => new Set(names).size === names.length),
				fingerprint: z.string().regex(FINGERPRINT_PATTERN),
			})
			.strict(),
		i18n: i18nConfigSchema.nullable(),
		database: z
			.object({
				type: z.enum(["sqlite", "postgres"]),
				executorEntrypoint: z.string().regex(EXECUTOR_ENTRYPOINT_PATTERN),
				executorConfig: z.unknown(),
			})
			.strict(),
	})
	.strict();

export type MigrationManifestV1 = z.infer<typeof migrationManifestV1Schema>;

export class MigrationManifestValidationError extends Error {
	constructor(message: string) {
		super(`Invalid migration manifest: ${message}`);
		this.name = "MigrationManifestValidationError";
	}
}

function isEnvironmentReferenceKey(key: string): boolean {
	return ENVIRONMENT_REFERENCE_KEY_PATTERN.test(key);
}

function assertSafeUrl(value: string, path: string): void {
	if (!URL_SCHEME_PATTERN.test(value)) return;

	let url: URL;
	try {
		url = new URL(value);
	} catch {
		throw new MigrationManifestValidationError(`${path} contains an invalid URL`);
	}

	if (CONNECTION_URL_PROTOCOLS.has(url.protocol)) {
		throw new MigrationManifestValidationError(`${path} contains a database connection URL`);
	}
	if (url.username || url.password) {
		throw new MigrationManifestValidationError(`${path} contains URL credentials`);
	}
	for (const key of url.searchParams.keys()) {
		if (SECRET_QUERY_KEY_PATTERN.test(key)) {
			throw new MigrationManifestValidationError(`${path} contains a credential query parameter`);
		}
	}
}

function cloneSecretFreeJson(value: unknown, path: string, ancestors: Set<object>): JsonValue {
	if (value === null || typeof value === "boolean") return value;
	if (typeof value === "string") {
		assertSafeUrl(value, path);
		return value;
	}
	if (typeof value === "number") {
		if (Number.isFinite(value)) return value;
		throw new MigrationManifestValidationError(`${path} contains a non-finite number`);
	}
	if (typeof value !== "object") {
		throw new MigrationManifestValidationError(`${path} is not JSON-serializable`);
	}
	if (ancestors.has(value)) {
		throw new MigrationManifestValidationError(`${path} contains a cycle`);
	}

	ancestors.add(value);
	try {
		if (Array.isArray(value)) {
			return value.map((item, index) => cloneSecretFreeJson(item, `${path}[${index}]`, ancestors));
		}

		const prototype = Object.getPrototypeOf(value);
		if (prototype !== Object.prototype && prototype !== null) {
			throw new MigrationManifestValidationError(`${path} contains a non-plain object`);
		}

		const cloned: Record<string, JsonValue> = {};
		for (const [key, item] of Object.entries(value)) {
			const itemPath = `${path}.${key}`;
			const environmentReference = isEnvironmentReferenceKey(key);
			if (
				!environmentReference &&
				(SECRET_CONFIG_KEY_PATTERN.test(key) || SECRET_CONFIG_EXACT_KEY_PATTERN.test(key))
			) {
				throw new MigrationManifestValidationError(`${itemPath} is a credential-bearing field`);
			}
			if (environmentReference) {
				if (typeof item !== "string" || !ENVIRONMENT_VARIABLE_PATTERN.test(item)) {
					throw new MigrationManifestValidationError(
						`${itemPath} must contain an environment-variable name`,
					);
				}
			}
			cloned[key] = cloneSecretFreeJson(item, itemPath, ancestors);
		}
		return cloned;
	} finally {
		ancestors.delete(value);
	}
}

export function validateSecretFreeExecutorConfig(
	value: unknown,
	path = "database.executorConfig",
): unknown {
	return cloneSecretFreeJson(value, path, new Set());
}

function identitiesMatch(
	manifest: MigrationManifestV1,
	expectedIdentity: CoreMigrationIdentity,
): boolean {
	return (
		manifest.emdashVersion === expectedIdentity.emdashVersion &&
		manifest.migrationSet.fingerprint === expectedIdentity.fingerprint &&
		manifest.migrationSet.names.length === expectedIdentity.names.length &&
		manifest.migrationSet.names.every((name, index) => name === expectedIdentity.names[index])
	);
}

export async function validateMigrationManifest(
	value: unknown,
	expectedIdentity?: CoreMigrationIdentity,
): Promise<MigrationManifestV1> {
	const parsed = migrationManifestV1Schema.safeParse(value);
	if (!parsed.success) {
		throw new MigrationManifestValidationError("schema validation failed");
	}

	const executorConfig = validateSecretFreeExecutorConfig(parsed.data.database.executorConfig);
	const manifest: MigrationManifestV1 = {
		...parsed.data,
		database: { ...parsed.data.database, executorConfig },
	};
	const fingerprint = await fingerprintMigrationSet(
		manifest.emdashVersion,
		manifest.migrationSet.names,
	);
	if (fingerprint !== manifest.migrationSet.fingerprint) {
		throw new MigrationManifestValidationError(
			"migrationSet fingerprint does not match its version and ordered names",
		);
	}
	if (expectedIdentity && !identitiesMatch(manifest, expectedIdentity)) {
		throw new MigrationManifestValidationError(
			"manifest does not match the loaded EmDash migration identity",
		);
	}

	return manifest;
}

export function serializeMigrationManifest(manifest: MigrationManifestV1): string {
	return `${JSON.stringify(manifest, null, "\t")}\n`;
}
