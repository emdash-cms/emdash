import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import type { EmDashConfig } from "../../src/astro/integration/runtime.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import type { Database } from "../../src/database/types.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../src/emdash-runtime.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../utils/test-db.js";

describe("EmDashRuntime.handleContentUpdate with revisions", () => {
	let db: Kysely<Database>;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		db = await setupTestDatabase();

		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
			supports: ["drafts", "revisions"],
		});
		await registry.createField("post", {
			slug: "title",
			label: "Title",
			type: "string",
		});
		await registry.createField("post", {
			slug: "content",
			label: "Content",
			type: "portableText",
		});

		const deps: RuntimeDependencies = {
			config: {} as EmDashConfig,
			plugins: [],
			createDialect: () => {
				throw new Error("createDialect should not be used in this test");
			},
			createStorage: null,
			sandboxEnabled: false,
			mediaProviderEntries: [],
			sandboxedPluginEntries: [],
			createSandboxRunner: null,
		};

		runtime = await runWithContext({ editMode: false, db }, () => EmDashRuntime.create(deps));
	});

	afterEach(async () => {
		await runtime.stopCron();
		await teardownTestDatabase(db);
	});

	it("returns the updated draft data for autosave on revision-backed collections", async () => {
		const created = await handleContentCreate(db, "post", {
			data: { title: "Original title" },
		});
		expect(created.success).toBe(true);

		const id = created.data!.item.id;

		const firstSave = await runtime.handleContentUpdate("post", id, {
			data: { title: "Draft one" },
			slug: "draft-one",
		});
		expect(firstSave.success).toBe(true);
		expect(firstSave.data?.item.draftRevisionId).toBeTruthy();

		const autosaved = await runtime.handleContentUpdate("post", id, {
			data: { title: "Draft two" },
			slug: "draft-two",
			skipRevision: true,
		});

		expect(autosaved.success).toBe(true);
		expect(autosaved.data?.item.data.title).toBe("Draft two");
		expect(autosaved.data?.item.slug).toBe("draft-two");

		const revisionRepo = new RevisionRepository(db);
		const draftRevision = await revisionRepo.findById(autosaved.data!.item.draftRevisionId!);
		expect(draftRevision?.data.title).toBe("Draft two");
		expect(draftRevision?.data._slug).toBe("draft-two");
	});
});
