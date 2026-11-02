/**
 * Runs in Node before the workerd pool starts: exports the origin test site
 * from Node SQLite and provides the package files (base64 by path) to the
 * workerd tests, which import them into D1.
 */

import type { TestProject } from "vitest/node";

import { packageFiles, runExport } from "../../integration/transfer/export/helpers.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";
import { createMemoryStorage } from "../../utils/transfer/memory-storage.js";
import { buildOriginSite } from "../../utils/transfer/origin-site.js";

declare module "vitest" {
	export interface ProvidedContext {
		sqliteSitePackage: Record<string, string>;
	}
}

export default async function setup(project: TestProject): Promise<void> {
	const db = await setupTestDatabase();
	try {
		const storage = createMemoryStorage();
		await buildOriginSite(db, storage);
		const run = await runExport(db, storage);
		if (run.result.outcome !== "complete") {
			throw new Error(`SQLite export ended as ${run.result.operation.state}`);
		}
		const files = await packageFiles(run.reader);
		project.provide(
			"sqliteSitePackage",
			Object.fromEntries(
				Array.from(files, ([path, bytes]) => [path, Buffer.from(bytes).toString("base64")]),
			),
		);
	} finally {
		await teardownTestDatabase(db);
	}
}
