import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { EmDashConfig } from "../../../src/astro/integration/runtime.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { Database } from "../../../src/database/types.js";
import { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { createHookPipeline } from "../../../src/plugins/hooks.js";
import type { ContentPolicyEvent } from "../../../src/plugins/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

function approvalStatus(event: ContentPolicyEvent): unknown {
	const data = event.content.data;
	return typeof data === "object" && data !== null && "approval_status" in data
		? data.approval_status
		: undefined;
}

function buildRuntime(db: Kysely<Database>, withPolicy = true): EmDashRuntime {
	const requireApproval = async (event: ContentPolicyEvent) =>
		approvalStatus(event) === "approved"
			? undefined
			: { cancel: true as const, reason: "Approval is required" };
	const plugin = definePlugin({
		id: "approval-policy",
		version: "1.0.0",
		capabilities: ["hooks.content-policy:register"],
		hooks: {
			"content:beforePublish": requireApproval,
			"content:beforeSchedule": requireApproval,
		},
	});
	const config: EmDashConfig = {};
	const pipelineFactoryOptions = { db } as const;
	const plugins = withPolicy ? [plugin] : [];
	const hooks = createHookPipeline(plugins, pipelineFactoryOptions);
	const runtimeDeps = {
		config,
		plugins,
		// eslint-disable-next-line typescript/no-explicit-any -- match RuntimeDependencies signature
		createDialect: (() => {
			throw new Error("createDialect not used in this test");
		}) as any,
		createStorage: null,
		sandboxEnabled: false,
		sandboxedPluginEntries: [],
		createSandboxRunner: null,
	};

	return new EmDashRuntime({
		db,
		storage: null,
		configuredPlugins: plugins,
		sandboxedPlugins: new Map(),
		sandboxedPluginEntries: [],
		hooks,
		enabledPlugins: new Set(plugins.map((entry) => entry.id)),
		pluginStates: new Map(),
		config,
		mediaProviders: new Map(),
		mediaProviderEntries: [],
		cronExecutor: null,
		cronScheduler: null,
		emailPipeline: null,
		allPipelinePlugins: plugins,
		pipelineFactoryOptions,
		runtimeDeps,
		pipelineRef: { current: hooks },
	});
}

describe("publication policy effective draft", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;
	let runtime: EmDashRuntime;

	beforeEach(async () => {
		db = await setupTestDatabase();
		const registry = new SchemaRegistry(db);
		await registry.createCollection({
			slug: "post",
			label: "Posts",
			labelSingular: "Post",
			supports: ["revisions"],
		});
		await registry.createField("post", {
			slug: "approval_status",
			label: "Approval status",
			type: "string",
		});
		repo = new ContentRepository(db);
		runtime = buildRuntime(db);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestDatabase(db);
	});

	async function publishedWithPendingDraft() {
		const item = await repo.create({
			type: "post",
			slug: "approval-policy",
			status: "draft",
			data: { approval_status: "approved" },
		});
		const published = await runtime.handleContentPublish("post", item.id);
		expect(published.success).toBe(true);
		const staged = await runtime.handleContentUpdate("post", item.id, {
			data: { approval_status: "pending" },
		});
		expect(staged.success).toBe(true);
		return item.id;
	}

	it("checks the pending draft before publishing it", async () => {
		const id = await publishedWithPendingDraft();

		const result = await runtime.handleContentPublish("post", id);

		expect(result).toMatchObject({ success: false, error: { code: "PUBLISH_REJECTED" } });
		const stored = await repo.findById("post", id);
		expect(stored?.data.approval_status).toBe("approved");
		expect(stored?.draftRevisionId).toBeTruthy();
	});

	it("checks the pending draft before scheduling it", async () => {
		const id = await publishedWithPendingDraft();

		const result = await runtime.handleContentSchedule("post", id, "2030-01-01T00:00:00.000Z");

		expect(result).toMatchObject({ success: false, error: { code: "SCHEDULE_REJECTED" } });
		expect((await repo.findById("post", id))?.scheduledAt).toBeNull();
	});

	it("fails closed when the pending draft cannot be read", async () => {
		const id = await publishedWithPendingDraft();
		const before = await repo.findById("post", id);
		vi.spyOn(RevisionRepository.prototype, "findById").mockRejectedValueOnce(
			new Error("draft read unavailable"),
		);

		const result = await runtime.handleContentPublish("post", id);

		expect(result).toMatchObject({ success: false, error: { code: "CONTENT_PUBLISH_ERROR" } });
		expect(await repo.findById("post", id)).toMatchObject({
			data: { approval_status: "approved" },
			draftRevisionId: before?.draftRevisionId,
			liveRevisionId: before?.liveRevisionId,
		});
	});

	it("does not hydrate policy input when no policy hook exists", async () => {
		const id = await publishedWithPendingDraft();
		const noPolicyRuntime = buildRuntime(db, false);
		const revisionRead = vi.spyOn(RevisionRepository.prototype, "findById");

		const result = await noPolicyRuntime.handleContentSchedule(
			"post",
			id,
			"2030-01-01T00:00:00.000Z",
		);

		expect(result.success).toBe(true);
		expect(revisionRead).not.toHaveBeenCalled();
	});

	it("returns a stale revision conflict before hydrating policy input", async () => {
		const id = await publishedWithPendingDraft();
		const revisionRead = vi.spyOn(RevisionRepository.prototype, "findById");

		const result = await runtime.handleContentPublish("post", id, { _rev: "stale-revision" });

		expect(result).toMatchObject({ success: false, error: { code: "CONFLICT" } });
		expect(revisionRead).not.toHaveBeenCalled();
	});
});
