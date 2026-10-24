import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: { AI: { run: vi.fn() } } }));

// Node has no crypto.subtle.timingSafeEqual; signature checks have their own tests.
vi.mock("../.flue/lib/webhook.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../.flue/lib/webhook.js")>()),
	verifyWebhookSignature: vi.fn(async () => true),
}));

const { default: app } = await import("../.flue/app.js");

const SECRET = "secret";

function rateLimitBinding(consumers: string[]) {
	const stub = {
		fetch: vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			const path = new URL(request.url).pathname;
			if (path === "/token") return Response.json({ token: "installation-token" });
			const body = await request.json<{ consumer: string }>();
			consumers.push(body.consumer);
			if (path === "/permit") return Response.json({ allowed: true, retryAt: 0 });
			return new Response(null, { status: 204 });
		}),
	};
	return { getByName: vi.fn(() => stub) };
}

async function deliver(event: unknown, env: Record<string, unknown>) {
	const body = JSON.stringify(event);
	return app.request(
		"/webhook/github",
		{
			method: "POST",
			body,
			headers: {
				"x-github-event": "pull_request_review",
				"x-github-delivery": "delivery-1",
				"x-hub-signature-256": "sha256=00",
			},
		},
		env,
	);
}

const review = {
	action: "submitted",
	review: { user: { login: "alice", type: "User" } },
	pull_request: { number: 42, state: "open", draft: false },
	repository: { name: "emdash", owner: { login: "emdash-cms" } },
};

describe("pull_request_review webhook", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("re-applies the review label through the shared rate-limit coordinator", async () => {
		const requests: string[] = [];
		vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
			const request = new Request(input, init);
			requests.push(`${request.method} ${new URL(request.url).pathname}`);
			return request.method === "GET"
				? Response.json([{ name: "review/awaiting-author" }])
				: Response.json([]);
		});
		const consumers: string[] = [];
		const env = {
			GITHUB_WEBHOOK_SECRET: SECRET,
			GITHUB_APP_INSTALLATION_ID: "1",
			GITHUB_RATE_LIMIT: rateLimitBinding(consumers),
		};

		const res = await deliver(review, env);

		expect(res.status).toBe(202);
		expect(requests).toEqual([
			"GET /repos/emdash-cms/emdash/issues/42/labels",
			"DELETE /repos/emdash-cms/emdash/issues/42/labels/review%2Fawaiting-author",
			"POST /repos/emdash-cms/emdash/issues/42/labels",
		]);
		expect(new Set(consumers)).toEqual(new Set(["webhook-review-state:delivery-1"]));
	});

	it("does nothing for a review by a bot", async () => {
		const fetchMock = vi.fn<typeof fetch>();
		vi.stubGlobal("fetch", fetchMock);
		const env = {
			GITHUB_WEBHOOK_SECRET: SECRET,
			GITHUB_APP_INSTALLATION_ID: "1",
			GITHUB_RATE_LIMIT: rateLimitBinding([]),
		};

		const res = await deliver(
			{ ...review, review: { user: { login: "emdash-autofix[bot]", type: "Bot" } } },
			env,
		);

		expect(res.status).toBe(202);
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
