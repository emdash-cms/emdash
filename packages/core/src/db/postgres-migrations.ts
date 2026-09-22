import { createDirectMigrationExecutor } from "../migrations/direct-executor.js";
import type { MigrationExecutor, MigrationExecutorFactoryContext } from "../migrations/protocol.js";
import { createMigrationTarget, requireMigrationEnvironment } from "../migrations/target.js";
import { createDialect } from "./postgres.js";

export interface PostgresMigrationManifestConfig {
	connectionStringEnv: string;
}

interface PostgresTargetIdentity {
	host: string;
	port: string;
	database: string;
}

function parseTargetIdentity(connectionString: string): PostgresTargetIdentity {
	let parsed: URL;
	try {
		parsed = new URL(connectionString);
	} catch {
		throw new Error("PostgreSQL migration connection string is invalid.");
	}
	if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
		throw new Error("PostgreSQL migration connection string is invalid.");
	}
	const database = parsed.pathname.slice(1);
	if (!parsed.hostname || !database) {
		throw new Error("PostgreSQL migration connection string must identify a host and database.");
	}
	return {
		host: parsed.hostname,
		port: parsed.port || "5432",
		database,
	};
}

export async function createMigrationExecutor(
	manifestConfig: PostgresMigrationManifestConfig,
	context: MigrationExecutorFactoryContext,
): Promise<MigrationExecutor> {
	const connectionStringEnv =
		context.overrides?.databaseUrlEnv ?? manifestConfig.connectionStringEnv;
	const connectionString = requireMigrationEnvironment(connectionStringEnv, context.env);
	const identity = parseTargetIdentity(connectionString);
	const label = `${identity.host}:${identity.port}/${identity.database}`;
	const target = await createMigrationTarget("postgres", label, [
		identity.host,
		identity.port,
		identity.database,
	]);
	return createDirectMigrationExecutor({
		target,
		createDialect: () =>
			createDialect({
				connectionString,
				pool: { min: 0, max: 1 },
			}),
	});
}
