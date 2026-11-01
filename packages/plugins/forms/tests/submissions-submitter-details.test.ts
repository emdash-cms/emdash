import type { RouteContext } from "emdash";
import { describe, expect, it } from "vitest";

import { submissionGetHandler, submissionsListHandler } from "../src/handlers/submissions.js";
import type { Submission } from "../src/types.js";

const ADMIN = 50;
const EDITOR = 40;

function storedSubmission(): Submission {
	return {
		formId: "form-1",
		data: { email: "visitor@example.com" },
		status: "new",
		starred: false,
		createdAt: "2026-01-01T00:00:00.000Z",
		meta: {
			ip: "203.0.113.7",
			userAgent: "Mozilla/5.0",
			referer: "https://example.com/contact",
			country: "DE",
		},
	};
}

function ctxWith(sub: Submission, user?: { role: number }): RouteContext {
	return {
		input: { id: "sub-1", formId: "form-1", limit: 50 },
		storage: {
			submissions: {
				get: async () => sub,
				query: async () => ({
					items: [{ id: "sub-1", data: sub }],
					hasMore: false,
					cursor: undefined,
				}),
			},
		},
		user,
	} as unknown as RouteContext;
}

const handlers = {
	"submissions/list": async (ctx: RouteContext) =>
		(await submissionsListHandler(ctx as never)).items[0],
	"submissions/get": (ctx: RouteContext) => submissionGetHandler(ctx as never),
};

describe.each(Object.entries(handlers))("%s submitter details", (_route, read) => {
	it("returns IP, user agent and referer to admins", async () => {
		const item = await read(ctxWith(storedSubmission(), { role: ADMIN }));
		expect(item?.meta).toEqual(storedSubmission().meta);
	});

	it("gives editors only the country and keeps the rest of the submission", async () => {
		const item = await read(ctxWith(storedSubmission(), { role: EDITOR }));
		expect(item?.meta).toEqual({ country: "DE" });
		expect(item?.id).toBe("sub-1");
		expect(item?.data).toEqual({ email: "visitor@example.com" });
	});

	it("gives only the country when the request has no user", async () => {
		const item = await read(ctxWith(storedSubmission()));
		expect(item?.meta).toEqual({ country: "DE" });
	});
});
