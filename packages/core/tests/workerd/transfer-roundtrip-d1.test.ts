/**
 * Site packages imported into D1 from an export on D1 and from an export on
 * Node SQLite (made by the `sqlite-package` global setup), each through the
 * import handlers to a verified receipt.
 */

import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { parseManifest } from "../../src/transfer/format/manifest.js";
import { MANIFEST_PATH } from "../../src/transfer/format/paths.js";
import { verifyReceiptDigest } from "../../src/transfer/format/receipt.js";
import { packageFiles, runExport } from "../integration/transfer/export/helpers.js";
import { seedTarget, TARGET_BOB } from "../integration/transfer/pipeline.js";
import { createMemoryStorage } from "../utils/transfer/memory-storage.js";
import { buildOriginSite } from "../utils/transfer/origin-site.js";
import { resetD1Schema } from "./d1-schema.js";
import { decodePackageFiles, importPackageFiles } from "./transfer-package.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
		TARGET_DB: D1Database;
	}
}

describe("site packages imported into D1", () => {
	let origin: Kysely<Database>;
	let target: Kysely<Database>;

	beforeAll(() => {
		origin = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
		target = new Kysely<Database>({
			dialect: new RawBindingD1Dialect({ database: env.TARGET_DB }),
		});
	});

	beforeEach(async () => {
		await resetD1Schema(origin);
		await resetD1Schema(target);
		await runMigrations(target);
		await seedTarget(target);
	});

	afterAll(async () => {
		await origin.destroy();
		await target.destroy();
	});

	async function expectImported(files: ReadonlyMap<string, Uint8Array>): Promise<void> {
		const operation = await importPackageFiles(target, createMemoryStorage(), files, TARGET_BOB);
		expect({ state: operation.state, error: operation.errorDetail }).toEqual({
			state: "complete",
			error: null,
		});
		const receipt = operation.receipt!;
		expect(await verifyReceiptDigest(receipt)).toBe(true);
		const manifest = parseManifest(files.get(MANIFEST_PATH)!);
		expect(receipt.originSiteId).toBe(manifest.originSiteId);
		expect(receipt.counts.entry).toBe(manifest.records.entry?.count);
	}

	it("imports a package exported from D1", async () => {
		await runMigrations(origin);
		const storage = createMemoryStorage();
		await buildOriginSite(origin, storage);
		const run = await runExport(origin, storage);
		expect(run.result.outcome).toBe("complete");
		await expectImported(await packageFiles(run.reader));
	});

	it("imports a package exported from Node SQLite", async () => {
		const files = decodePackageFiles(inject("sqliteSitePackage"));
		expect(files.size).toBeGreaterThan(3);
		await expectImported(files);
	});
});
