import type { KyselyPlugin } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleContentPublish, handleContentUpdate } from "../../../src/api/handlers/content.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { MediaRepository } from "../../../src/database/repositories/media.js";
import { RelationRepository } from "../../../src/database/repositories/relation.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { publishDueContent } from "../../../src/scheduled-publish.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	asInlineTransaction,
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("complete publication validation", (dialect) => {
	for (const supportsRevisions of [true, false]) {
		describe(supportsRevisions ? "with revisions" : "without revisions", () => {
			let context: DialectTestContext;
			let runtime: EmDashRuntime;
			let registry: SchemaRegistry;

			beforeEach(async () => {
				context = await setupForDialect(dialect);
				registry = new SchemaRegistry(context.db);
				await registry.createCollection({
					slug: "posts",
					label: "Posts",
					supports: supportsRevisions ? ["revisions"] : [],
				});
				await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
				runtime = createTestRuntime(context.db);
			});

			afterEach(async () => teardownForDialect(context));

			async function createEntry(data: Record<string, unknown> = { title: "Original" }) {
				const created = await runtime.handleContentCreate("posts", { data, slug: "entry" });
				expect(created.success).toBe(true);
				return created.data!.item.id;
			}

			async function requireSummary() {
				await registry.createField("posts", {
					slug: "summary",
					label: "Summary",
					type: "string",
					required: true,
				});
			}

			async function requireRelatedPage() {
				await registry.createCollection({ slug: "pages", label: "Pages", supports: [] });
				await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
				const page = await new ContentRepository(context.db).create({
					type: "pages",
					slug: "related",
					data: { title: "Related page" },
					status: "published",
				});
				await new RelationRepository(context.db).create({
					slug: "posts_related_pages",
					parentCollection: "posts",
					childCollection: "pages",
					parentLabel: "Posts",
					childLabel: "Pages",
				});
				await registry.createField("posts", {
					slug: "related_pages",
					label: "Pages",
					type: "reference",
					required: true,
					validation: {
						relation: "posts_related_pages",
						relationSide: "parent",
						targetCollection: "pages",
					},
				});
				return page;
			}

			it("rejects a never-published entry missing a required field with structured issues", async () => {
				const id = await createEntry();
				await requireSummary();
				const published = await runtime.handleContentPublish("posts", id);
				expect(published).toMatchObject({
					success: false,
					error: {
						code: "VALIDATION_ERROR",
						details: {
							issues: expect.arrayContaining([
								expect.objectContaining({ path: "summary", code: "required" }),
							]),
						},
					},
				});
				expect((await new ContentRepository(context.db).findById("posts", id))?.status).toBe(
					"draft",
				);
			});

			it("rejects republication while preserving the live revision and pending draft", async () => {
				const id = await createEntry();
				expect((await runtime.handleContentPublish("posts", id)).success).toBe(true);
				await requireSummary();
				const saved = await runtime.handleContentUpdate("posts", id, { data: { title: "Edited" } });
				expect(saved.success).toBe(true);
				const before = await new ContentRepository(context.db).findById("posts", id);
				const published = await runtime.handleContentPublish("posts", id, {
					_rev: saved.data!._rev,
				});
				expect(published).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
				const after = await new ContentRepository(context.db).findById("posts", id);
				expect(after?.status).toBe("published");
				expect(after?.data).toEqual(before?.data);
				expect(after?.liveRevisionId).toBe(before?.liveRevisionId);
				expect(after?.draftRevisionId).toBe(before?.draftRevisionId);
			});

			it("rejects an explicit published status update with an incomplete live candidate", async () => {
				const id = await createEntry();
				await requireSummary();
				const updated = await runtime.handleContentUpdate("posts", id, { status: "published" });
				expect(updated).toMatchObject({
					success: false,
					error: {
						code: "VALIDATION_ERROR",
						details: {
							issues: expect.arrayContaining([expect.objectContaining({ path: "summary" })]),
						},
					},
				});
				expect((await new ContentRepository(context.db).findById("posts", id))?.status).toBe(
					"draft",
				);
			});

			it("still permits partial saves on published entries needing a new required field", async () => {
				const id = await createEntry();
				expect((await runtime.handleContentPublish("posts", id)).success).toBe(true);
				await requireSummary();
				const saved = await runtime.handleContentUpdate("posts", id, {
					data: { title: "Work in progress" },
				});
				expect(saved.success).toBe(true);
			});

			it("publishes complete content after a partial save", async () => {
				await requireSummary();
				const id = await createEntry({ title: "Original", summary: "Complete summary" });
				const saved = await runtime.handleContentUpdate("posts", id, { data: { title: "Edited" } });
				expect(saved.success).toBe(true);
				const published = await runtime.handleContentPublish("posts", id);
				expect(published.success).toBe(true);
				expect(published.data!.item.data).toMatchObject({
					title: "Edited",
					summary: "Complete summary",
				});
			});

			it("validates the live content an explicit status update actually exposes", async () => {
				const id = await createEntry();
				await requireSummary();
				const updated = await runtime.handleContentUpdate("posts", id, {
					data: { summary: "Complete summary" },
					status: "published",
				});
				const stored = await new ContentRepository(context.db).findById("posts", id);
				if (supportsRevisions) {
					expect(updated).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
					expect(stored?.status).toBe("draft");
				} else {
					expect(updated.success).toBe(true);
					expect(stored?.status).toBe("published");
					expect(stored?.data.summary).toBe("Complete summary");
				}
			});

			it("rejects stored content that no longer meets the field's validation bounds", async () => {
				const id = await createEntry();
				await registry.updateField("posts", "title", { validation: { maxLength: 3 } });
				const published = await runtime.handleContentPublish("posts", id);
				expect(published).toMatchObject({
					success: false,
					error: {
						code: "VALIDATION_ERROR",
						details: {
							issues: expect.arrayContaining([expect.objectContaining({ path: "title" })]),
						},
					},
				});
				expect((await new ContentRepository(context.db).findById("posts", id))?.status).toBe(
					"draft",
				);
			});

			it.each(["publish", "status update"])(
				"rejects a tightened media MIME allowlist during %s",
				async (operation) => {
					await registry.createField("posts", {
						slug: "attachment",
						label: "Attachment",
						type: "file",
						validation: { allowedMimeTypes: ["application/pdf"] },
					});
					const media = await new MediaRepository(context.db).create({
						filename: "attachment.pdf",
						mimeType: "application/pdf",
						storageKey: "attachment.pdf",
					});
					const id = await createEntry({ title: "Original", attachment: { id: media.id } });
					const repo = new ContentRepository(context.db);
					const before = await repo.findById("posts", id);
					await registry.updateField("posts", "attachment", {
						validation: { allowedMimeTypes: ["application/zip"] },
					});
					const publish = () =>
						operation === "publish"
							? runtime.handleContentPublish("posts", id)
							: runtime.handleContentUpdate("posts", id, { status: "published" });
					expect(await publish()).toMatchObject({
						success: false,
						error: { code: "INVALID_MIME_FOR_FIELD" },
					});
					expect(await repo.findById("posts", id)).toMatchObject({
						status: "draft",
						data: before!.data,
						liveRevisionId: before!.liveRevisionId,
						draftRevisionId: before!.draftRevisionId,
					});
					await registry.updateField("posts", "attachment", {
						validation: { allowedMimeTypes: ["application/pdf"] },
					});
					expect((await publish()).success).toBe(true);
				},
			);

			it.each(["publish", "status update"])(
				"rejects a newly-required live reference selection during %s",
				async (operation) => {
					const id = await createEntry();
					await requireRelatedPage();
					const result =
						operation === "publish"
							? await runtime.handleContentPublish("posts", id)
							: await runtime.handleContentUpdate("posts", id, { status: "published" });
					expect(result).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
					expect((await new ContentRepository(context.db).findById("posts", id))?.status).toBe(
						"draft",
					);
				},
			);

			it("validates the reference selection an explicit status update actually makes live", async () => {
				const id = await createEntry();
				const page = await requireRelatedPage();
				const references = { related_pages: [page.id] };
				const updated = await runtime.handleContentUpdate("posts", id, {
					status: "published",
					references,
				});
				if (supportsRevisions) {
					expect(updated).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
					expect((await new ContentRepository(context.db).findById("posts", id))?.status).toBe(
						"draft",
					);
					expect((await runtime.handleContentUpdate("posts", id, { references })).success).toBe(
						true,
					);
					expect((await runtime.handleContentPublish("posts", id)).success).toBe(true);
				} else {
					expect(updated.success).toBe(true);
				}
				const stored = await new ContentRepository(context.db).findById("posts", id);
				expect(stored?.status).toBe("published");
				const live = await new RelationRepository(context.db).getChildrenPage(
					"posts_related_pages",
					stored!.translationGroup!,
				);
				expect(live.items.map((edge) => edge.childGroup)).toEqual([page.translationGroup]);
				expect(
					(await runtime.handleContentUpdate("posts", id, { status: "published" })).success,
				).toBe(true);
			});

			it("keeps invalid due content scheduled and publishes it after correction", async () => {
				const id = await createEntry();
				await requireSummary();
				const scheduledAt = "2000-01-02T00:00:00.000Z";
				const currentTime = new Date("2000-01-03T00:00:00.000Z");
				const repo = new ContentRepository(context.db);
				await repo.schedule("posts", id, scheduledAt, new Date("2000-01-01T00:00:00.000Z"));
				const sweep = () =>
					publishDueContent(context.db, {
						currentTime,
						publish: (collection, entryId, options) =>
							runtime.handleContentPublish(collection, entryId, options),
					});
				expect(await sweep()).toEqual([]);
				expect(await sweep()).toEqual([]);
				expect(await repo.findById("posts", id)).toMatchObject({
					status: "scheduled",
					scheduledAt,
				});
				expect(
					(await runtime.handleContentUpdate("posts", id, { data: { summary: "Corrected" } }))
						.success,
				).toBe(true);
				expect(await sweep()).toEqual([expect.objectContaining({ collection: "posts", id })]);
				expect(await repo.findById("posts", id)).toMatchObject({
					status: "published",
					scheduledAt: null,
				});
			});

			it.each(["publish", "status update"])(
				"fences the validated snapshot for a blind %s",
				async (operation) => {
					const id = await createEntry();
					let snapshots = 0;
					let mutated = false;
					const plugin: KyselyPlugin = {
						transformQuery(args) {
							return args.node;
						},
						async transformResult(args) {
							const row = args.result.rows[0];
							if (row?.id === id && Object.hasOwn(row, "version")) snapshots += 1;
							if (!mutated && snapshots === 2) {
								mutated = true;
								const saved = await runtime.handleContentUpdate("posts", id, {
									data: { title: "Concurrent edit" },
								});
								expect(saved.success).toBe(true);
							}
							return args.result;
						},
					};
					const publishDb = asInlineTransaction(context.db.withPlugin(plugin));
					const result =
						operation === "publish"
							? await handleContentPublish(publishDb, "posts", id)
							: await handleContentUpdate(publishDb, "posts", id, { status: "published" });
					expect(mutated).toBe(true);
					expect(result).toMatchObject({ success: false, error: { code: "CONFLICT" } });
					const stored = await new ContentRepository(context.db).findById("posts", id);
					expect(stored?.status).toBe("draft");
					const savedData = supportsRevisions
						? (await new RevisionRepository(context.db).findById(stored!.draftRevisionId!))!.data
						: stored!.data;
					expect(savedData.title).toBe("Concurrent edit");
				},
			);

			if (supportsRevisions) {
				it("validates an effective draft separately from the live row used by a status update", async () => {
					await registry.createField("posts", {
						slug: "summary",
						label: "Summary",
						type: "string",
					});
					const id = await createEntry({ title: "Original", summary: "Live summary" });
					expect((await runtime.handleContentPublish("posts", id)).success).toBe(true);
					expect(
						(await runtime.handleContentUpdate("posts", id, { data: { summary: "" } })).success,
					).toBe(true);
					await registry.updateField("posts", "summary", { validation: { minLength: 1 } });
					expect(
						(await runtime.handleContentUpdate("posts", id, { status: "published" })).success,
					).toBe(true);
					const published = await runtime.handleContentPublish("posts", id);
					expect(published).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
					expect(
						(await new ContentRepository(context.db).findById("posts", id))?.data.summary,
					).toBe("Live summary");
				});

				it("publishes a historical draft after a field has been retired", async () => {
					await registry.createField("posts", {
						slug: "retired",
						label: "Retired",
						type: "string",
					});
					const id = await createEntry({ title: "Original", retired: "Historical value" });
					await registry.deleteField("posts", "retired");
					const published = await runtime.handleContentPublish("posts", id);
					expect(published.success).toBe(true);
					expect(published.data!.item.data.title).toBe("Original");
					expect(published.data!.item.data).not.toHaveProperty("retired");
				});

				it("rejects invalid content before promoting staged references without transactions", async () => {
					await registry.createCollection({ slug: "pages", label: "Pages", supports: [] });
					await registry.createField("pages", { slug: "title", label: "Title", type: "string" });
					const repo = new ContentRepository(context.db);
					const first = await repo.create({
						type: "pages",
						slug: "first",
						data: { title: "First page" },
						status: "published",
					});
					const second = await repo.create({
						type: "pages",
						slug: "second",
						data: { title: "Second page" },
						status: "published",
					});
					const relations = new RelationRepository(context.db);
					await relations.create({
						slug: "posts_related_pages",
						parentCollection: "posts",
						childCollection: "pages",
						parentLabel: "Posts",
						childLabel: "Pages",
					});
					await registry.createField("posts", {
						slug: "related_pages",
						label: "Pages",
						type: "reference",
						validation: {
							relation: "posts_related_pages",
							relationSide: "parent",
							targetCollection: "pages",
						},
					});
					const created = await runtime.handleContentCreate("posts", {
						data: { title: "Original" },
						slug: "entry",
						references: { related_pages: [first.id] },
					});
					expect(created.success).toBe(true);
					const id = created.data!.item.id;
					expect((await runtime.handleContentPublish("posts", id)).success).toBe(true);
					expect(
						(
							await runtime.handleContentUpdate("posts", id, {
								references: { related_pages: [second.id] },
							})
						).success,
					).toBe(true);
					await requireSummary();
					const before = await repo.findById("posts", id);
					const published = await handleContentPublish(
						asInlineTransaction(context.db),
						"posts",
						id,
					);
					expect(published).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
					const live = await relations.getChildrenPage(
						"posts_related_pages",
						before!.translationGroup!,
					);
					expect(live.items.map((edge) => edge.childGroup)).toEqual([first.translationGroup]);
					expect((await repo.findById("posts", id))?.draftRevisionId).toBe(before!.draftRevisionId);
				});
			}
		});
	}
});
