import { env } from "cloudflare:test";
import { Kysely } from "kysely";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { RawBindingD1Dialect } from "../../../cloudflare/src/db/d1-dialect.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { startingRevisionId } from "../../src/database/repositories/revision.js";
import type { Database } from "../../src/database/types.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { createTestRuntime } from "../utils/mcp-runtime.js";
import { resetD1Schema } from "./d1-schema.js";

declare module "cloudflare:test" {
	interface ProvidedEnv {
		DB: D1Database;
	}
}

const COLLECTION = "credit_d1";
const ANA = { id: "user_ana", role: 30 };
const BEN = { id: "user_ben", role: 30 };

let db: Kysely<Database>;
let runtime: ReturnType<typeof createTestRuntime>;

beforeAll(() => {
	db = new Kysely<Database>({ dialect: new RawBindingD1Dialect({ database: env.DB }) });
});

beforeEach(async () => {
	await resetD1Schema(db);
	await runMigrations(db);

	const registry = new SchemaRegistry(db);
	await registry.createCollection({ slug: COLLECTION, label: "D1 credit" });
	await registry.createField(COLLECTION, { slug: "title", label: "Title", type: "string" });

	runtime = createTestRuntime(db);
});

afterAll(async () => {
	await db.destroy();
});

/** A new post, and the revision its first save keeps of its starting content. */
async function createPost(): Promise<{ id: string; start: string }> {
	const created = await runtime.handleContentCreate(COLLECTION, {
		data: { title: "Start" },
		slug: "credit",
	});
	expect(created.success).toBe(true);
	const { item } = created.data!;
	return { id: item.id, start: startingRevisionId(COLLECTION, item.id, item.createdAt) };
}

async function save(
	id: string,
	actor: { id: string; role: number },
	title: string,
	autosave = false,
): Promise<string> {
	const result = await runtime.handleContentUpdate(COLLECTION, id, {
		data: { title },
		skipRevision: autosave,
		actor,
	});
	expect(result.success).toBe(true);
	return result.data!.item.draftRevisionId!;
}

async function revisionIds(id: string): Promise<string[]> {
	const list = await runtime.handleRevisionList(COLLECTION, id);
	expect(list.success).toBe(true);
	return list.data!.items.map((item) => item.id);
}

async function credit(revisionId: string) {
	const row = await db
		.selectFrom("revisions")
		.select(["kind", "edited_by"])
		.where("id", "=", revisionId)
		.executeTakeFirstOrThrow();
	return {
		kind: row.kind,
		editedBy: row.edited_by === null ? null : (JSON.parse(row.edited_by) as unknown),
	};
}

describe("autosave revision credit on D1", () => {
	it("keeps a manual save when the next autosave lands", async () => {
		const { id, start } = await createPost();
		const manual = await save(id, ANA, "Saved by hand");

		const autosaved = await save(id, ANA, "Typed after saving", true);

		expect(await revisionIds(id)).toEqual([autosaved, manual, start]);
	});

	it("replaces one user's autosave with the next", async () => {
		const { id, start } = await createPost();
		await save(id, ANA, "First", true);

		const second = await save(id, ANA, "Second", true);

		expect(await revisionIds(id)).toEqual([second, start]);
		expect(await credit(second)).toEqual({ kind: "autosave", editedBy: [ANA.id] });
	});

	it("names everyone who autosaved into a version, latest first, once each", async () => {
		const { id, start } = await createPost();
		await save(id, ANA, "Ana types", true);

		const byBen = await save(id, BEN, "Ben types", true);
		expect(await revisionIds(id)).toEqual([byBen, start]);
		expect(await credit(byBen)).toEqual({ kind: "autosave", editedBy: [BEN.id, ANA.id] });

		const byAna = await save(id, ANA, "Ana types again", true);
		expect(await revisionIds(id)).toEqual([byAna, start]);
		expect(await credit(byAna)).toEqual({ kind: "autosave", editedBy: [ANA.id, BEN.id] });
	});
});
