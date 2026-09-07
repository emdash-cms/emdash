import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { TestServerContext } from "../server.js";
import { assertNodeVersion, createTestServer } from "../server.js";

const PORT = 4404;

function adminFetch(ctx: TestServerContext, path: string, init?: RequestInit): Promise<Response> {
	return fetch(`${ctx.baseUrl}${path}`, {
		...init,
		headers: {
			Authorization: `Bearer ${ctx.token}`,
			"X-EmDash-Request": "1",
			"Content-Type": "application/json",
			...(init?.headers as Record<string, string>),
		},
	});
}

async function configureComments(
	ctx: TestServerContext,
	commentsModeration: "all" | "first_time",
	commentsAutoApproveUsers: boolean,
): Promise<void> {
	const response = await adminFetch(ctx, "/_emdash/api/schema/collections/posts", {
		method: "PUT",
		body: JSON.stringify({
			commentsEnabled: true,
			commentsModeration,
			commentsAutoApproveUsers,
		}),
	});
	if (!response.ok) {
		const body = await response.text().catch(() => "");
		throw new Error(`Failed to configure comments (${response.status}): ${body}`);
	}
}

describe("Comment session authentication", () => {
	let ctx: TestServerContext;

	beforeAll(async () => {
		assertNodeVersion();
		ctx = await createTestServer({ port: PORT });
	});

	afterAll(async () => {
		await ctx?.cleanup();
	});

	it("keeps an anonymous first comment pending without a CMS user identity", async () => {
		await configureComments(ctx, "first_time", true);
		const postId = ctx.contentIds.posts![0]!;
		const submitResponse = await fetch(`${ctx.baseUrl}/_emdash/api/comments/posts/${postId}`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Origin: ctx.baseUrl,
			},
			body: JSON.stringify({
				authorName: "Anonymous Visitor",
				authorEmail: "anonymous@example.com",
				body: "Anonymous first comment",
			}),
		});

		expect(submitResponse.status).toBe(201);
		const submission = (await submitResponse.json()) as {
			data: { id: string; status: string; message: string };
		};
		expect(submission.data.status).toBe("pending");
		expect(submission.data.message).toBe("Comment submitted for review");

		const detailResponse = await adminFetch(
			ctx,
			`/_emdash/api/admin/comments/${submission.data.id}`,
		);
		expect(detailResponse.status).toBe(200);
		const detail = (await detailResponse.json()) as {
			data: {
				status: string;
				authorName: string;
				authorEmail: string;
				authorUserId: string | null;
			};
		};
		expect(detail.data).toMatchObject({
			status: "pending",
			authorName: "Anonymous Visitor",
			authorEmail: "anonymous@example.com",
			authorUserId: null,
		});
	});

	it("retains the CMS user identity and auto-approves their first comment", async () => {
		await configureComments(ctx, "first_time", true);
		const meResponse = await fetch(`${ctx.baseUrl}/_emdash/api/auth/me`, {
			headers: { Cookie: ctx.sessionCookie },
		});
		expect(meResponse.status).toBe(200);
		const me = (await meResponse.json()) as {
			data: { id: string; email: string };
		};

		const postId = ctx.contentIds.posts![1]!;
		const listResponse = await fetch(`${ctx.baseUrl}/_emdash/api/comments/posts/${postId}`);
		expect(listResponse.status).toBe(200);
		const list = (await listResponse.json()) as { data: { total: number } };
		expect(list.data.total).toBe(0);

		const submitResponse = await fetch(`${ctx.baseUrl}/_emdash/api/comments/posts/${postId}`, {
			method: "POST",
			headers: {
				Cookie: ctx.sessionCookie,
				"Content-Type": "application/json",
				Origin: ctx.baseUrl,
			},
			body: JSON.stringify({
				authorName: "Submitted Name",
				authorEmail: "submitted@example.com",
				body: "Session-authenticated comment",
			}),
		});

		expect(submitResponse.status).toBe(201);
		const submission = (await submitResponse.json()) as {
			data: { id: string; status: string; message: string };
		};
		expect(submission.data.status).toBe("approved");
		expect(submission.data.message).toBe("Comment published");

		const detailResponse = await adminFetch(
			ctx,
			`/_emdash/api/admin/comments/${submission.data.id}`,
		);
		expect(detailResponse.status).toBe(200);
		const detail = (await detailResponse.json()) as {
			data: {
				status: string;
				authorName: string;
				authorEmail: string;
				authorUserId: string | null;
			};
		};
		expect(detail.data).toMatchObject({
			status: "approved",
			authorName: "Dev Admin",
			authorEmail: me.data.email,
			authorUserId: me.data.id,
		});
	});

	it("retains the CMS user identity when authenticated comments require moderation", async () => {
		await configureComments(ctx, "all", false);

		const meResponse = await fetch(`${ctx.baseUrl}/_emdash/api/auth/me`, {
			headers: { Cookie: ctx.sessionCookie },
		});
		expect(meResponse.status).toBe(200);
		const me = (await meResponse.json()) as {
			data: { id: string; email: string };
		};

		const postId = ctx.contentIds.posts![0]!;
		const submitResponse = await fetch(`${ctx.baseUrl}/_emdash/api/comments/posts/${postId}`, {
			method: "POST",
			headers: {
				Cookie: ctx.sessionCookie,
				"Content-Type": "application/json",
				Origin: ctx.baseUrl,
			},
			body: JSON.stringify({
				authorName: "Submitted Name",
				authorEmail: "submitted@example.com",
				body: "Authenticated comment awaiting moderation",
			}),
		});

		expect(submitResponse.status).toBe(201);
		const submission = (await submitResponse.json()) as {
			data: { id: string; status: string; message: string };
		};
		expect(submission.data.status).toBe("pending");
		expect(submission.data.message).toBe("Comment submitted for review");

		const detailResponse = await adminFetch(
			ctx,
			`/_emdash/api/admin/comments/${submission.data.id}`,
		);
		expect(detailResponse.status).toBe(200);
		const detail = (await detailResponse.json()) as {
			data: {
				status: string;
				authorName: string;
				authorEmail: string;
				authorUserId: string | null;
			};
		};
		expect(detail.data).toMatchObject({
			status: "pending",
			authorName: "Dev Admin",
			authorEmail: me.data.email,
			authorUserId: me.data.id,
		});
	});
});
