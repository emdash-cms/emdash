import { createMigrationExecutor as createPostgresMigrationExecutor } from "emdash/db/postgres-migrations";
import type { MigrationExecutor, MigrationExecutorFactoryContext } from "emdash/migrations";

const BINDING_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export interface HyperdriveMigrationManifestConfig {
	binding: string;
	connectionStringEnv: string;
}

export async function createMigrationExecutor(
	manifestConfig: HyperdriveMigrationManifestConfig,
	context: MigrationExecutorFactoryContext,
): Promise<MigrationExecutor> {
	if (
		typeof manifestConfig !== "object" ||
		manifestConfig === null ||
		!BINDING_PATTERN.test(manifestConfig.binding)
	) {
		throw new Error("The Hyperdrive migration binding is invalid.");
	}
	return createPostgresMigrationExecutor(
		{ connectionStringEnv: manifestConfig.connectionStringEnv },
		context,
	);
}
