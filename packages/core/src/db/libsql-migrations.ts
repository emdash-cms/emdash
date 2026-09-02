import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createDirectMigrationExecutor } from "../migrations/direct-executor.js";
import type { MigrationExecutor, MigrationExecutorFactoryContext } from "../migrations/protocol.js";
import { createMigrationTarget, requireMigrationEnvironment } from "../migrations/target.js";
import { createDialect } from "./libsql.js";

export interface LibsqlMigrationManifestConfig {
	url: string;
	authTokenEnv: string;
}

interface ResolvedLibsqlUrl {
	connectionUrl: string;
	label: string;
	identity: string[];
	requiresAuthToken: boolean;
}

function resolveLibsqlUrl(url: unknown, projectRoot: string): ResolvedLibsqlUrl {
	if (typeof url !== "string" || url.length === 0) {
		throw new Error("libSQL migration URL is missing.");
	}
	if (url.startsWith("file:")) {
		const configuredPath = url.slice(5);
		if (configuredPath.length === 0) throw new Error("libSQL migration URL is invalid.");
		const fileUrl = pathToFileURL(resolve(projectRoot, configuredPath));
		return {
			connectionUrl: fileUrl.href,
			label: fileUrl.href,
			identity: [fileUrl.protocol, fileUrl.pathname],
			requiresAuthToken: false,
		};
	}

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("libSQL migration URL is invalid.");
	}
	if (parsed.username || parsed.password) {
		throw new Error("libSQL migration URL must not contain credentials.");
	}
	const label = `${parsed.protocol}//${parsed.host}${parsed.pathname}`;
	return {
		connectionUrl: url,
		label,
		identity: [parsed.protocol, parsed.host, parsed.pathname],
		requiresAuthToken: true,
	};
}

export async function createMigrationExecutor(
	manifestConfig: LibsqlMigrationManifestConfig,
	context: MigrationExecutorFactoryContext,
): Promise<MigrationExecutor> {
	const resolvedUrl = resolveLibsqlUrl(manifestConfig.url, context.projectRoot);
	const authToken = resolvedUrl.requiresAuthToken
		? requireMigrationEnvironment(manifestConfig.authTokenEnv, context.env)
		: undefined;
	const target = await createMigrationTarget("libsql", resolvedUrl.label, resolvedUrl.identity);
	return createDirectMigrationExecutor({
		target,
		createDialect: () =>
			createDialect({
				url: resolvedUrl.connectionUrl,
				authToken,
			}),
	});
}
