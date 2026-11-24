import { Role, type RoleLevel } from "@emdash-cms/auth";
import { afterEach, beforeEach, expect, it } from "vitest";

import { handleRecoveryRevisionCreate } from "../../../src/api/handlers/rooms.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { RevisionRepository } from "../../../src/database/repositories/revision.js";
import type { EmDashRuntime } from "../../../src/emdash-runtime.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { ContentHookEvent } from "../../../src/plugins/types.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const EDITOR = { id: "user_editor", role: Role.EDITOR as RoleLevel };
const SUBSCRIBER = { id: "user_subscriber", role: Role.SUBSCRIBER as RoleLevel };
const DISABLED = { id: "user_disabled", role: Role.EDITOR as RoleLevel };

describeEachDialect("restoring a recovery revision", (dialect) => {
	let ctx: DialectTestContext;
	let runtime: EmDashRuntime;
	let seen: ContentHookEvent[];
	let entryId: string;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		await ctx.db
			.insertInto("users")
			.values(
				[EDITOR, SUBSCRIBER, DISABLED].map((user) => ({
					id: user.id,
					email: `${user.id}@example.com`,
					name: user.id,
					role: user.role,
					email_verified: 1,
					disabled: user === DISABLED ? 1 : 0,
				})),
			)
			.execute();
		seen = [];
		const probe = definePlugin({
			id: "recovery-probe",
			version: "1.0.0",
			capabilities: ["content:write"],
			hooks: {
				"content:beforeSave": {
					handler: async (event: ContentHookEvent) => {
						seen.push(event);
						return { ...event.content, title: `${String(event.content.title)} (checked)` };
					},
				},
			},
		});
		runtime = createTestRuntime(ctx.db, { plugins: [probe] });
		const entry = await new ContentRepository(ctx.db).create({
			type: "post",
			data: { title: "Original" },
			slug: "original",
			status: "draft",
			authorId: EDITOR.id,
		});
		entryId = entry.id;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function recovery(data: Record<string, unknown>, slug: string | null = "recovered") {
		const result = await handleRecoveryRevisionCreate(ctx.db, {
			collection: "post",
			id: entryId,
			user: EDITOR,
			data,
			slug,
		});
		if (!result.success) throw new Error(result.error.message);
		return result.data.id;
	}

	async function draft() {
		const item = await new ContentRepository(ctx.db).findById("post", entryId);
		if (!item?.draftRevisionId) return null;
		return ctx.db
			.selectFrom("revisions")
			.select(["id", "kind", "data", "author_id"])
			.where("id", "=", item.draftRevisionId)
			.executeTakeFirstOrThrow();
	}

	it("saves its fields and slug as the restoring user, through content:beforeSave", async () => {
		const id = await recovery({ title: "Recovered" });

		const result = await runtime.handleRevisionRestore(id, EDITOR.id, EDITOR.role);

		expect(result.success).toBe(true);
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			collection: "post",
			isNew: false,
			id: entryId,
			content: { title: "Recovered" },
			actor: { id: EDITOR.id },
		});
		expect(seen[0]!.content).not.toHaveProperty("_slug");
		const stored = await draft();
		expect(stored).toMatchObject({ kind: null, author_id: EDITOR.id });
		expect(stored!.id).not.toBe(id);
		expect(JSON.parse(stored!.data)).toMatchObject({
			title: "Recovered (checked)",
			_slug: "recovered",
		});
	});

	it("keeps the entry's slug when the recovery revision has none", async () => {
		const id = await recovery({ title: "Recovered" }, null);

		const result = await runtime.handleRevisionRestore(id, EDITOR.id, EDITOR.role);

		expect(result.success).toBe(true);
		const stored = await draft();
		expect(JSON.parse(stored!.data)._slug).not.toBeNull();
	});

	it("validates its fields and saves nothing when they fail", async () => {
		const before = await draft();
		const id = await recovery({ title: "Recovered", content: 42 });

		const result = await runtime.handleRevisionRestore(id, EDITOR.id, EDITOR.role);

		expect(result).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
		expect(await draft()).toEqual(before);
	});

	it("reads the restoring user's role when the caller gives none", async () => {
		const id = await recovery({ title: "Recovered" });

		for (const user of [SUBSCRIBER, DISABLED, { id: "user_gone" }]) {
			expect(await runtime.handleRevisionRestore(id, user.id)).toMatchObject({
				success: false,
				error: { code: "FORBIDDEN" },
			});
		}
		expect(seen).toEqual([]);

		expect((await runtime.handleRevisionRestore(id, EDITOR.id)).success).toBe(true);
		expect(seen).toHaveLength(1);
	});

	it("restores other revisions as before, without hooks", async () => {
		const revision = await new RevisionRepository(ctx.db).create({
			collection: "post",
			entryId,
			data: { title: "Earlier", _slug: "earlier" },
			authorId: EDITOR.id,
		});

		const result = await runtime.handleRevisionRestore(revision.id, EDITOR.id, EDITOR.role);

		expect(result.success).toBe(true);
		expect(seen).toEqual([]);
		expect(JSON.parse((await draft())!.data)).toMatchObject({ title: "Earlier" });
	});
});
