/**
 * Exercises the real hook handlers with a stubbed context to verify the
 * before/after diff flow: beforeSave observes the prior state (keyed by
 * the event's id, since the update payload carries no id of its own) and
 * afterSave writes it into the audit entry.
 */

import { describe, expect, it, vi } from "vitest";

import plugin from "../src/plugin.js";

function createCtx() {
	return {
		content: {
			// Shape matches ContentAccess.get(): the item envelope with the
			// field data under `data`.
			get: vi.fn(async () => ({
				id: "post-1",
				type: "posts",
				slug: "audit-test",
				status: "draft",
				data: { title: "old title" },
				createdAt: "2026-08-30T00:00:00.000Z",
				updatedAt: "2026-08-30T00:00:00.000Z",
				locale: "en",
				publishedAt: null,
				scheduledAt: null,
			})),
		},
		storage: {
			entries: {
				put: vi.fn(async () => undefined),
			},
		},
		log: {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
		},
	};
}

describe("update audit entries", () => {
	it("records the prior state as changes.before", async () => {
		const ctx = createCtx();
		// eslint-disable-next-line typescript-eslint/no-explicit-any -- stub context stands in for PluginContext
		const hooks = plugin.hooks as any;

		await hooks["content:beforeSave"].handler(
			{ content: { title: "new title" }, collection: "posts", isNew: false, id: "post-1" },
			ctx,
		);
		await hooks["content:afterSave"].handler(
			{
				content: { id: "post-1", data: { title: "new title" } },
				collection: "posts",
				isNew: false,
			},
			ctx,
		);

		expect(ctx.content.get).toHaveBeenCalledWith("posts", "post-1");
		const entry = ctx.storage.entries.put.mock.calls[0]?.[1] as {
			action: string;
			changes?: { before?: unknown; after?: unknown };
		};
		expect(entry.action).toBe("update");
		expect(entry.changes?.before).toEqual({ title: "old title" });
		expect(entry.changes?.after).toEqual({ title: "new title" });
	});
});
