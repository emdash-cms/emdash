import { isAbsolute, resolve } from "node:path";

import { createDirectMigrationExecutor } from "../migrations/direct-executor.js";
import type { MigrationExecutor, MigrationExecutorFactoryContext } from "../migrations/protocol.js";
import { createMigrationTarget } from "../migrations/target.js";
import { createDialect } from "./sqlite.js";

export interface SqliteMigrationManifestConfig {
	url: string;
}

function resolveDatabasePath(
	manifestConfig: SqliteMigrationManifestConfig,
	context: MigrationExecutorFactoryContext,
): string {
	const configuredUrl = context.overrides?.database ?? manifestConfig.url;
	if (typeof configuredUrl !== "string" || configuredUrl.length === 0) {
		throw new Error("SQLite migration database path is missing.");
	}
	const path = configuredUrl.startsWith("file:") ? configuredUrl.slice(5) : configuredUrl;
	if (path.length === 0) {
		throw new Error("SQLite migration database path is missing.");
	}
	return isAbsolute(path) ? resolve(path) : resolve(context.projectRoot, path);
}

export async function createMigrationExecutor(
	manifestConfig: SqliteMigrationManifestConfig,
	context: MigrationExecutorFactoryContext,
): Promise<MigrationExecutor> {
	const databasePath = resolveDatabasePath(manifestConfig, context);
	const target = await createMigrationTarget("sqlite", databasePath, [databasePath]);
	return createDirectMigrationExecutor({
		target,
		createDialect: () => createDialect({ url: databasePath }),
	});
}
