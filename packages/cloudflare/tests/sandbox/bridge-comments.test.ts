import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

import { PluginBridge, setCommentModerateCallback } from "../../src/sandbox/bridge.js";

function bridge(capabilities: string[]) {
	const ctx = {
		props: {
			pluginId: "comment-plugin",
			pluginVersion: "1.0.0",
			capabilities,
			allowedHosts: [],
			storageCollections: [],
		},
	};
	return new PluginBridge(ctx as never, { DB: {} } as never);
}

afterEach(() => setCommentModerateCallback(null));

describe("PluginBridge comment capability enforcement", () => {
	it("denies comment reads and moderation without their capabilities", async () => {
		await expect(bridge([]).commentGet("comment-1")).rejects.toThrow(
			"Missing capability: comments:read",
		);
		await expect(
			bridge(["comments:read"]).commentSetStatus("comment-1", "approved", "pending"),
		).rejects.toThrow("Missing capability: comments:moderate");
	});

	it("routes expected-status moderation through the runtime callback with plugin origin", async () => {
		const moderate = vi.fn(async (pluginId, id, status, expectedStatus) => ({
			id,
			collection: "posts",
			contentId: "post-1",
			parentId: null,
			authorName: "Reader",
			authorEmail: "reader@example.com",
			body: "Hello",
			status,
			ipHash: null,
			userAgent: null,
			moderationMetadata: null,
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:01.000Z",
			expectedStatus,
			pluginId,
		}));
		setCommentModerateCallback(moderate);

		await expect(
			bridge(["comments:read", "comments:moderate"]).commentSetStatus(
				"comment-1",
				"approved",
				"pending",
			),
		).resolves.toMatchObject({ id: "comment-1", status: "approved" });
		expect(moderate).toHaveBeenCalledWith("comment-plugin", "comment-1", "approved", "pending");
		await expect(
			bridge(["comments:read", "comments:moderate"]).commentSetStatus(
				"comment-1",
				"trash" as never,
				"pending",
			),
		).resolves.toEqual({
			__emdashCommentError: {
				code: "COMMENT_STATUS_INVALID",
				message: "status must be one of: approved, pending, spam",
			},
		});
		expect(moderate).toHaveBeenCalledTimes(1);
	});
});
