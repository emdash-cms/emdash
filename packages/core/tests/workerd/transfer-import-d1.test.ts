import { env } from "cloudflare:test";
import { Kysely, sql } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { verifyImportStep } from "../../src/transfer/export/verify.js";
import { verifyReceiptDigest } from "../../src/transfer/format/receipt.js";
import { advanceImport } from "../../src/transfer/import/index.js";
import { TransferStepBudget } from "../../src/transfer/ops/budget.js";
import { seedTarget, stageGoldenImport } from "../integration/transfer/import/harness.js";
import { GOLDEN_IDS } from "../utils/transfer/golden-package.js";
import { createMemoryStorage } from "../utils/transfer/memory-storage.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

const BIND_LIMIT = 100;
const STEP_QUERY_CEILING = 900;

describe("site import on D1", () => {
	let db: Kysely<Database>;
	const metrics = { dbCount: 0 };
	let maxBinds = 0;

	beforeAll(() => {
		const counted = new Proxy(env.DB, {
			get(target, property) {
				if (property === "prepare") {
					return (query: string) => {
						metrics.dbCount++;
						const statement = target.prepare(query);
						return new Proxy(statement, {
							get(inner, key) {
								if (key === "bind") {
									return (...values: unknown[]) => {
										maxBinds = Math.max(maxBinds, values.length);
										return inner.bind(...values);
									};
								}
								const value: unknown = Reflect.get(inner, key);
								return typeof value === "function" ? value.bind(inner) : value;
							},
						});
					};
				}
				const value: unknown = Reflect.get(target, property);
				return typeof value === "function" ? value.bind(target) : value;
			},
		});
		db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: counted }) });
	});

	beforeEach(async () => {
		await resetD1Schema(db);
		await runMigrations(db);
		await seedTarget(db);
	});

	afterAll(async () => {
		await db.destroy();
	});

	it("imports and verifies the golden package within D1's limits", async () => {
		const storage = createMemoryStorage();
		const staged = await stageGoldenImport(db, storage, "sqlite");
		const perStep: number[] = [];
		maxBinds = 0;
		for (let step = 0; ; step++) {
			expect(step).toBeLessThan(500);
			metrics.dbCount = 0;
			const result = await advanceImport({
				db,
				storage,
				operationId: staged.operationId,
				verify: verifyImportStep,
				budget: new TransferStepBudget({ metrics, queryCeiling: STEP_QUERY_CEILING }),
			});
			perStep.push(metrics.dbCount);
			if (result.nextRequestInMs !== null) continue;

			expect(result.operation.errorDetail).toBeNull();
			expect(result.operation.state).toBe("complete");
			expect(await verifyReceiptDigest(result.operation.receipt!)).toBe(true);
			break;
		}
		expect(Math.max(...perStep)).toBeLessThanOrEqual(STEP_QUERY_CEILING);
		expect(maxBinds).toBeLessThanOrEqual(BIND_LIMIT);

		const violations = await sql`PRAGMA foreign_key_check`.execute(db);
		expect(violations.rows).toEqual([]);
		await expect(
			db.deleteFrom("revisions").where("id", "=", GOLDEN_IDS.helloLive).execute(),
		).rejects.toThrow(/FOREIGN KEY/i);

		const entry = await db
			.selectFrom("ec_posts" as "revisions")
			.select([
				sql<string>`live_revision_id`.as("live"),
				sql<string>`draft_revision_id`.as("draft"),
			])
			.where("id", "=", GOLDEN_IDS.hello)
			.executeTakeFirstOrThrow();
		expect(entry).toEqual({ live: GOLDEN_IDS.helloLive, draft: GOLDEN_IDS.helloDraft });
	});
});
