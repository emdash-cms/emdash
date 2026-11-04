import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import type { Database } from "../../src/database/types.js";
import { TransferError } from "../../src/transfer/errors.js";
import { findSiteWriteFenceError } from "../../src/transfer/fence.js";
import {
	availableSha256Backends,
	createSha256,
	sha256Hex,
} from "../../src/transfer/format/digest.js";
import { TransferOperationRepository } from "../../src/transfer/ops/operations.js";
import { putVerified } from "../../src/transfer/staging/stage.js";
import { createMemoryStorage } from "../utils/transfer/memory-storage.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

const encoder = new TextEncoder();

describe("site transfer hashing on workerd", () => {
	it("prefers crypto.DigestStream and every backend agrees", async () => {
		const backends = await availableSha256Backends();
		expect(backends[0]).toBe("digest-stream");
		const bytes = encoder.encode("a".repeat(1_000_000));
		for (const backend of backends) {
			const hasher = await createSha256({ backend });
			for (let offset = 0; offset < bytes.length; offset += 7_777) {
				hasher.update(bytes.subarray(offset, offset + 7_777));
			}
			expect(await hasher.digest(), backend).toBe(
				"cdc76e5c9914fb9281a1c7e284d73e67f1809a48a497200e046d39ccc7112cd0",
			);
		}
	});

	it("streams verified uploads through FixedLengthStream", async () => {
		const storage = createMemoryStorage();
		const body = encoder.encode("hello staged world");
		await putVerified(storage, "k", new Blob([body]).stream(), {
			bytes: body.byteLength,
			sha256: await sha256Hex(body),
		});
		expect(storage.files.get("k")?.body).toEqual(body);

		await expect(
			putVerified(storage, "short", new Blob([body.subarray(1)]).stream(), {
				bytes: body.byteLength,
				sha256: await sha256Hex(body),
			}),
		).rejects.toBeInstanceOf(TransferError);
		expect(storage.files.has("short")).toBe(false);
	});
});

describe("site transfer state on D1", () => {
	let db: Kysely<Database>;

	let statements = 0;

	beforeAll(() => {
		const counted = new Proxy(env.DB, {
			get(target, property) {
				if (property === "prepare") {
					return (query: string) => {
						statements++;
						return target.prepare(query);
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
	});

	afterAll(async () => {
		await db.destroy();
	});

	it("enforces one occupying import and fences writes with a single query", async () => {
		const repo = new TransferOperationRepository(db);
		const { operation } = await repo.create({ kind: "import", createdBy: "u1" });
		await expect(repo.create({ kind: "import", createdBy: "u2" })).rejects.toMatchObject({
			code: "TRANSFER_IMPORT_IN_PROGRESS",
		});
		expect(await findSiteWriteFenceError(db)).toBeNull();

		const claim = await repo.claim(operation.id, ["uploading"]);
		if (claim.outcome !== "claimed") throw new Error("expected claim");
		await repo.advance(operation.id, claim.leaseToken, {
			state: "running",
			markMutationStarted: true,
		});
		statements = 0;
		expect(await findSiteWriteFenceError(db)).toMatchObject({
			code: "TRANSFER_IMPORT_IN_PROGRESS",
		});
		expect(statements).toBe(1);
		expect((await repo.claim(operation.id, ["running"])).outcome).toBe("lease_active");
	});
});
