import type { DatabaseDescriptor } from "../db/adapters.js";
import { validateSecretFreeExecutorConfig } from "./manifest.js";

export const MIGRATION_CONFIG_SYMBOL = Symbol.for("emdash:migration-config");

export interface MigrationIntegrationMetadata {
	database?: Pick<DatabaseDescriptor, "type" | "migrations">;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
	return typeof value === "object" && value !== null;
}

function isMigrationIntegrationMetadata(value: unknown): value is MigrationIntegrationMetadata {
	if (!isRecord(value)) return false;
	const database = value.database;
	if (database === undefined) return true;
	if (!isRecord(database) || (database.type !== "sqlite" && database.type !== "postgres")) {
		return false;
	}

	const migrations = database.migrations;
	return (
		migrations === undefined ||
		(isRecord(migrations) &&
			typeof migrations.entrypoint === "string" &&
			Object.hasOwn(migrations, "manifestConfig"))
	);
}

export function createMigrationIntegrationMetadata(
	database?: DatabaseDescriptor,
): MigrationIntegrationMetadata {
	if (!database) return {};

	return {
		database: {
			type: database.type,
			migrations: database.migrations
				? {
						entrypoint: database.migrations.entrypoint,
						manifestConfig: validateSecretFreeExecutorConfig(
							database.migrations.manifestConfig,
							"database.migrations.manifestConfig",
						),
					}
				: undefined,
		},
	};
}

export function getMigrationIntegrationMetadata(
	integration: unknown,
): MigrationIntegrationMetadata | undefined {
	if (
		(typeof integration !== "object" || integration === null) &&
		typeof integration !== "function"
	) {
		return undefined;
	}
	if (!Object.hasOwn(integration, MIGRATION_CONFIG_SYMBOL)) {
		return undefined;
	}

	const metadata: unknown = Reflect.get(integration, MIGRATION_CONFIG_SYMBOL);
	return isMigrationIntegrationMetadata(metadata) ? metadata : undefined;
}
