import {
	createDirectMigrationExecutor,
	type MigrationExecutor,
	type MigrationExecutorFactoryContext,
} from "emdash/migrations";

import { resolveD1MigrationTarget, type D1MigrationManifestConfig } from "./d1-migration-target.js";
import { D1RestDialect } from "./d1-rest-dialect.js";

export async function createMigrationExecutor(
	manifestConfig: D1MigrationManifestConfig,
	context: MigrationExecutorFactoryContext,
): Promise<MigrationExecutor> {
	const resolved = await resolveD1MigrationTarget(manifestConfig, context);
	const token = context.env.CLOUDFLARE_API_TOKEN;
	if (!token) throw new Error("CLOUDFLARE_API_TOKEN is required for D1 migrations.");
	return createDirectMigrationExecutor({
		target: resolved.target,
		createDialect: () =>
			new D1RestDialect({
				accountId: resolved.accountId,
				databaseId: resolved.databaseId,
				token,
			}),
	});
}
