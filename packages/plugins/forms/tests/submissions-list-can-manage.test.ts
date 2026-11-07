import type { RouteContext } from "emdash";
import { describe, expect, it } from "vitest";

import { submissionsListHandler } from "../src/handlers/submissions.js";

const ADMIN = 50;
const EDITOR = 40;

function ctxFor(user?: { role: number }): RouteContext {
	return {
		input: { formId: "form-1", limit: 50 },
		storage: {
			submissions: {
				query: async () => ({ items: [], hasMore: false, cursor: undefined }),
			},
		},
		user,
	} as unknown as RouteContext;
}

describe("submissions/list canManage", () => {
	it("is true for admins, who may delete and export", async () => {
		const result = await submissionsListHandler(ctxFor({ role: ADMIN }) as never);
		expect(result.canManage).toBe(true);
	});

	it("is false for editors", async () => {
		const result = await submissionsListHandler(ctxFor({ role: EDITOR }) as never);
		expect(result.canManage).toBe(false);
	});

	it("is false when the request has no user", async () => {
		const result = await submissionsListHandler(ctxFor() as never);
		expect(result.canManage).toBe(false);
	});
});
