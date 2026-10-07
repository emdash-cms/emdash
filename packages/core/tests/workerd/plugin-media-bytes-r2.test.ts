import { env, exports as workerExports } from "cloudflare:workers";
import { Kysely } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { MediaRepository } from "../../src/database/repositories/media.js";
import type { Database } from "../../src/database/types.js";

declare global {
	namespace Cloudflare {
		interface Env {
			DB: D1Database;
			MEDIA: R2Bucket;
		}
		interface GlobalProps {
			mainModule: typeof import("./fixtures/plugin-storage-worker.js");
		}
	}
}

let db: Kysely<Database>;
let mediaId: string;
const bytes = Uint8Array.from({ length: 342_000 }, (_, index) => index % 256);

beforeAll(async () => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
	await runMigrations(db);
	await env.MEDIA.put("private/probe.bin", bytes);
	const item = await new MediaRepository(db).create({
		filename: "probe.bin",
		mimeType: "application/octet-stream",
		storageKey: "private/probe.bin",
		size: 1,
		status: "ready",
	});
	mediaId = item.id;
});

afterAll(async () => {
	await db.destroy();
});

function bridge(capabilities = ["media:bytes:read"]) {
	return workerExports.PluginBridge({
		props: {
			pluginId: "media-probe",
			pluginVersion: "1.0.0",
			capabilities,
			allowedHosts: [],
			storageCollections: [],
		},
	});
}

async function readBytes(maxBytes?: number) {
	return await bridge().mediaReadBytes(mediaId, maxBytes);
}

describe("sandbox media bytes through R2 bridge RPC", () => {
	it("reads exact bytes before, during, and after concurrent calls without a storage callback", async () => {
		const expectedHash = await crypto.subtle.digest("SHA-256", bytes);
		async function expectExactBytes(result: Awaited<ReturnType<typeof readBytes>>) {
			expect(result).toMatchObject({ size: bytes.byteLength, filename: "probe.bin" });
			expect(await crypto.subtle.digest("SHA-256", result.bytes)).toEqual(expectedHash);
		}
		await expectExactBytes(await readBytes());
		const results = await Promise.all(Array.from({ length: 24 }, () => readBytes()));
		await Promise.all(results.map(expectExactBytes));
		await expectExactBytes(await readBytes());
	});

	it("enforces the stream byte limit even when the stored size is smaller", async () => {
		await expect(readBytes(bytes.byteLength - 1)).rejects.toThrow(
			`Media exceeds the requested ${bytes.byteLength - 1}-byte limit`,
		);
		await expect(readBytes(bytes.byteLength)).resolves.toMatchObject({ size: bytes.byteLength });
	});

	it("requires byte-read authority with an R2 binding available", async () => {
		async function readWithoutCapability() {
			return await bridge(["media:read"]).mediaReadBytes(mediaId);
		}
		await expect(readWithoutCapability()).rejects.toThrow("Missing capability: media:bytes:read");
	});

	it("hides private storage keys when the R2 object is missing", async () => {
		const missing = await new MediaRepository(db).create({
			filename: "missing.bin",
			mimeType: "application/octet-stream",
			storageKey: "private/missing.bin",
			status: "ready",
		});
		async function readMissing() {
			return await bridge().mediaReadBytes(missing.id);
		}
		await expect(readMissing()).rejects.toThrow(/^Failed to read media bytes$/);
	});
});
