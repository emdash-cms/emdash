import { Role } from "@emdash-cms/auth";
import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, expect, it } from "vitest";

import { EmDashD1Dialect, RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { GET, POST } from "../../src/astro/routes/api/admin/media-usage/activation.js";
import {
	GET as GET_PROGRESS,
	POST as POST_PROGRESS,
} from "../../src/astro/routes/api/admin/media-usage/progress.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { MEDIA_USAGE_ACTIVATION_RUNTIME_GENERATION } from "../../src/media/usage/activation.js";
import { SchemaRegistry } from "../../src/schema/registry.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

interface D1Measurement {
	queries: number;
	rowsRead: number;
	rowsWritten: number;
	durationMs: number;
	wallDurationMs: number;
	maxBinds: number;
	maxSqlBytes: number;
}

type D1Mode = "raw" | "session";
type RouteContext = Parameters<typeof GET>[0];

let adminDb: Kysely<Database>;

beforeAll(async () => {
	adminDb = new Kysely<Database>({
		dialect: new RawBindingD1Dialect({ database: env.DB }),
	});
	await runMigrations(adminDb);
});

afterAll(async () => {
	await adminDb.destroy();
});

it("keeps complete authenticated activation route costs within the D1 envelope", async () => {
	const evidence: Array<{ path: string; mode: D1Mode } & D1Measurement> = [];

	await record("get-expanded", "raw", GET, activationGet(), 200, evidence);
	await record("empty-activation", "session", POST, activationPost(), 200, evidence);
	await record("get-active-empty", "session", GET, activationGet(), 200, evidence);

	await resetActivation("expanded", null);
	const registry = new SchemaRegistry(adminDb);
	await registry.createCollection({ slug: "activation_alpha", label: "Activation alpha" });
	await registry.createCollection({ slug: "activation_beta", label: "Activation beta" });

	await record("first-collection", "raw", POST, activationPost(), 200, evidence);
	await record("get-activating", "session", GET, activationGet(), 200, evidence);
	await record("final-collection", "session", POST, activationPost(), 200, evidence);
	await record("get-active", "raw", GET, activationGet(), 200, evidence);
	await record("progress-indexing", "session", GET_PROGRESS, progressGet(), 200, evidence);
	expect(evidence.at(-1)).toEqual(expect.objectContaining({ queries: 1, rowsWritten: 0 }));
	await record("progress-step", "session", POST_PROGRESS, progressPost(), 200, evidence);
	await record("active-idempotent", "session", POST, activationPost(), 200, evidence);

	await adminDb
		.updateTable("_emdash_media_usage_activation")
		.set({
			state: "activating",
			collection_cursor: "activation_alpha",
			lease_token: "private-owner",
			lease_expires_at: "2100-01-01T00:00:00.000Z",
		})
		.where("task_key", "=", "incremental_capture")
		.execute();
	await record("live-lease", "raw", POST, activationPost(), 409, evidence);
	await adminDb
		.updateTable("_emdash_media_usage_activation")
		.set({ lease_expires_at: "2000-01-01T00:00:00.000Z" })
		.where("task_key", "=", "incremental_capture")
		.execute();
	await record("expired-lease-replay", "session", POST, activationPost(), 200, evidence);

	await resetActivation("expanded", "activation_beta");
	await registry.createCollection({ slug: "activation_zz_broken", label: "Activation broken" });
	await sql`DROP TABLE ${sql.ref("ec_activation_zz_broken")}`.execute(adminDb);
	await record("installation-failure", "raw", POST, activationPost(), 500, evidence);
	await record("failure-retry", "session", POST, activationPost(), 500, evidence);

	console.info(`PR4_D1_ACTIVATION=${JSON.stringify(evidence)}`);
});

async function record(
	path: string,
	mode: D1Mode,
	handler: typeof GET,
	request: Request,
	expectedStatus: number,
	evidence: Array<{ path: string; mode: D1Mode } & D1Measurement>,
): Promise<void> {
	const measurement = emptyMeasurement();
	const db = measuredDb(mode, measurement);
	const startedAt = performance.now();
	const response = await handler(routeContext(db, request));
	measurement.wallDurationMs = Number((performance.now() - startedAt).toFixed(3));
	await db.destroy();

	expect(response.status).toBe(expectedStatus);
	expect(measurement.queries).toBeLessThanOrEqual(40);
	expect(measurement.maxBinds).toBeLessThanOrEqual(100);
	expect(measurement.maxSqlBytes).toBeLessThan(100 * 1024);
	expect(measurement.wallDurationMs).toBeLessThan(2500);
	evidence.push({ path, mode, ...measurement });
}

function measuredDb(mode: D1Mode, measurement: D1Measurement): Kysely<Database> {
	const binding =
		mode === "raw" ? env.DB : (env.DB.withSession("first-primary") as unknown as D1Database);
	const database = captureD1(binding, measurement);
	return new Kysely<Database>({
		dialect:
			mode === "raw" ? new RawBindingD1Dialect({ database }) : new EmDashD1Dialect({ database }),
	});
}

function routeContext(db: Kysely<Database>, request: Request): RouteContext {
	return {
		request,
		locals: {
			emdash: { db },
			user: { id: "admin-1", role: Role.ADMIN },
			tokenScopes: ["admin"],
		},
	} as RouteContext;
}

function activationGet(): Request {
	return new Request("http://localhost/_emdash/api/admin/media-usage/activation");
}

function activationPost(): Request {
	return new Request("http://localhost/_emdash/api/admin/media-usage/activation", {
		method: "POST",
		headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
		body: JSON.stringify({ writersDrained: true }),
	});
}

function progressGet(): Request {
	return new Request("http://localhost/_emdash/api/admin/media-usage/progress");
}

function progressPost(): Request {
	return new Request("http://localhost/_emdash/api/admin/media-usage/progress", {
		method: "POST",
		headers: { "X-EmDash-Request": "1" },
	});
}

async function resetActivation(state: "expanded" | "activating", cursor: string | null) {
	await adminDb
		.updateTable("_emdash_media_usage_activation")
		.set({
			state,
			runtime_generation: MEDIA_USAGE_ACTIVATION_RUNTIME_GENERATION,
			collection_cursor: cursor,
			drain_confirmed_at: null,
			lease_token: null,
			lease_expires_at: null,
			attempt_count: 0,
			last_attempted_at: null,
			last_error_code: null,
			activated_at: null,
		})
		.where("task_key", "=", "incremental_capture")
		.execute();
}

function emptyMeasurement(): D1Measurement {
	return {
		queries: 0,
		rowsRead: 0,
		rowsWritten: 0,
		durationMs: 0,
		wallDurationMs: 0,
		maxBinds: 0,
		maxSqlBytes: 0,
	};
}

function captureD1(database: D1Database, measurement: D1Measurement): D1Database {
	return new Proxy(database, {
		get(target, property) {
			if (property === "prepare") {
				return (query: string) => captureStatement(target.prepare(query), query, [], measurement);
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}

function captureStatement(
	statement: D1PreparedStatement,
	query: string,
	binds: unknown[],
	measurement: D1Measurement,
): D1PreparedStatement {
	return new Proxy(statement, {
		get(target, property) {
			if (property === "bind") {
				return (...values: unknown[]) =>
					captureStatement(target.bind(...values), query, values, measurement);
			}
			if (property === "all") {
				return async <T>() => {
					measurement.queries++;
					measurement.maxBinds = Math.max(measurement.maxBinds, binds.length);
					measurement.maxSqlBytes = Math.max(
						measurement.maxSqlBytes,
						new TextEncoder().encode(query).byteLength,
					);
					const result = await target.all<T>();
					measurement.rowsRead += result.meta.rows_read;
					measurement.rowsWritten += result.meta.rows_written;
					measurement.durationMs += result.meta.duration;
					return result;
				};
			}
			const value: unknown = Reflect.get(target, property, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
}
