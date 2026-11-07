import type { D1Database } from "@cloudflare/workers-types";
import type { Database, DatabaseDescriptor } from "emdash";
import { type Dialect, Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";

interface BridgeDialectModule {
	createDialect?: (config: unknown) => Dialect | Promise<Dialect>;
	createRequestScopedDb: (options: {
		config: unknown;
		isAuthenticated: boolean;
		isWrite: boolean;
		cookies: { get: () => undefined; set: () => void };
		url: URL;
	}) => { db: Kysely<Database>; close?: () => void } | null;
}

let dialectModulePromise: Promise<BridgeDialectModule> | undefined;

function loadDialectModule(): Promise<BridgeDialectModule> {
	// @ts-ignore - virtual module
	dialectModulePromise ??= import("virtual:emdash/dialect");
	return dialectModulePromise;
}

/** Each bridge RPC owns its connection, including all queries in multi-step writes. */
export async function withBridgeDb<T>(
	descriptor: DatabaseDescriptor | undefined,
	fn: (db: Kysely<Database>) => Promise<T>,
	legacyDb?: D1Database,
): Promise<T> {
	if (!descriptor) {
		const db = new Kysely<Database>({ dialect: new D1Dialect({ database: legacyDb! }) });
		try {
			return await fn(db);
		} finally {
			await db.destroy();
		}
	}
	// Only the configured adapter is bundled, so D1 sites do not need the optional pg dependency.
	const adapter = await loadDialectModule();
	const scope = adapter.createRequestScopedDb({
		config: descriptor.config,
		// Bridge reads must observe earlier plugin writes, not a replica or query cache.
		isAuthenticated: true,
		isWrite: true,
		cookies: { get: () => undefined, set: () => {} },
		url: new URL("https://emdash.invalid/_emdash/plugin-bridge"),
	});
	if (!scope && !adapter.createDialect)
		throw new Error("Sandbox database adapter is not configured");
	const db =
		scope?.db ?? new Kysely<Database>({ dialect: await adapter.createDialect!(descriptor.config) });
	try {
		return await fn(db);
	} finally {
		if (scope?.close) scope.close();
		else await db.destroy();
	}
}
