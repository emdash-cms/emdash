/**
 * Imports a site package, given as its files by path, the way a client does:
 * through the import handlers, from the manifest to the receipt.
 */

import type { Kysely } from "kysely";

import {
	handleImportAdvance,
	handleImportAnalyze,
	handleImportCreate,
	handleImportExecute,
	handleImportFileUpload,
	handleImportMissing,
} from "../../src/api/handlers/transfer.js";
import type { ApiResult } from "../../src/api/types.js";
import type { Database } from "../../src/database/types.js";
import type { Storage } from "../../src/storage/types.js";
import { analysisTargetContext } from "../../src/transfer/analyze/target.js";
import { MANIFEST_PATH } from "../../src/transfer/format/paths.js";
import type { PublicTransferOperation } from "../../src/transfer/ops/operations.js";

const MAX_STEPS = 2000;

const TARGET = analysisTargetContext({
	i18n: { defaultLocale: "en", locales: ["en", "fr"] },
	maxUploadSize: 50 * 1024 * 1024,
});

function unwrap<T>(result: ApiResult<T>): T {
	if (!result.success) throw new Error(`${result.error.code}: ${result.error.message}`);
	return result.data;
}

export async function importPackageFiles(
	db: Kysely<Database>,
	storage: Storage,
	files: ReadonlyMap<string, Uint8Array>,
	userId: string,
): Promise<PublicTransferOperation> {
	const manifest = files.get(MANIFEST_PATH);
	if (!manifest) throw new Error("package has no manifest");
	const created = unwrap(await handleImportCreate(db, storage, { userId, manifest }));
	const operationId = created.operation.id;

	for (let round = 0; ; round++) {
		if (round > 10) throw new Error("uploads did not converge");
		const missing = unwrap(await handleImportMissing(db, operationId, { limit: 100 }));
		if (missing.items.length === 0) break;
		for (const file of missing.items) {
			const bytes = files.get(file.path);
			if (!bytes) throw new Error(`package has no ${file.path}`);
			unwrap(
				await handleImportFileUpload(db, storage, {
					operationId,
					path: file.path,
					contentLength: bytes.byteLength,
					body: new Response(bytes).body,
					maxBlobBytes: TARGET.maxUploadSize,
				}),
			);
		}
	}

	for (let step = 0; ; step++) {
		if (step > MAX_STEPS) throw new Error("analysis did not finish");
		const analysis = unwrap(
			await handleImportAnalyze(db, storage, { operationId, target: TARGET }),
		);
		if (analysis.nextRequestInMs !== null) continue;
		if (!analysis.plan || !analysis.planDigest) {
			throw new Error(`analysis ended as ${analysis.operation.state}`);
		}
		if (analysis.plan.blockers.length > 0) {
			throw new Error(`plan has blockers: ${JSON.stringify(analysis.plan.blockers)}`);
		}
		unwrap(
			await handleImportExecute(db, storage, {
				operationId,
				userId,
				packageDigest: analysis.operation.packageDigest!,
				planDigest: analysis.planDigest,
			}),
		);
		break;
	}

	for (let step = 0; ; step++) {
		if (step > MAX_STEPS) throw new Error("import did not finish");
		const advanced = unwrap(await handleImportAdvance(db, storage, { operationId, userId }));
		if (advanced.nextRequestInMs === null) return advanced.operation;
	}
}

export function decodePackageFiles(encoded: Record<string, string>): Map<string, Uint8Array> {
	return new Map(
		Object.entries(encoded).map(([path, base64]) => [
			path,
			Uint8Array.from(atob(base64), (char) => char.charCodeAt(0)),
		]),
	);
}
