/**
 * The webhook is the only step in a submission whose outcome nobody waits for. It has to survive the
 * response being sent, and a response that is not a success has to reach the log: `fetch` resolves on
 * a 4xx, a 5xx, and on the login page an auth wall redirects to, so none of those reject.
 *
 * The redirect case is subtle, so these do NOT fake a `Response`. Plugin HTTP access follows redirects itself
 * with `redirect: "manual"` so it can strip credentials on a cross-origin hop, which means the response it hands
 * back reports `redirected: false` however many hops it took, and its `url` is the LAST URL fetched. `followsManually`
 * below is that loop, so the handler sees exactly the response shape production gives it; a fixture that set
 * `redirected` by hand would pass while production silently failed.
 *
 * The real `createHttpAccess` is not used directly because it resolves the hostname over DoH before every request,
 * which a unit test cannot do offline.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { submitHandler } from "../src/handlers/submit.js";
import type { FormDefinition } from "../src/types.js";

const WEBHOOK = "https://example.test/hook";
const LOGIN = "https://example.test/login";

/** The webhook runs after the response, so let its microtasks drain before asserting. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function form(): FormDefinition {
	return {
		name: "Contact",
		slug: "contact",
		status: "active",
		pages: [{ fields: [{ name: "email", label: "Email", type: "email", required: true }] }],
		submissionCount: 0,
		lastSubmissionAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		settings: {
			spamProtection: "none",
			notifyEmails: [],
			digestEnabled: false,
			digestHour: 9,
			retentionDays: 0,
			submitLabel: "Send",
			confirmationMessage: "Thanks",
			webhookUrl: WEBHOOK,
		},
	} as unknown as FormDefinition;
}

/** A response as `globalThis.fetch` returns it: `url` is the URL that was requested. */
function reply(url: string, status: number, headers: Record<string, string> = {}): Response {
	const res = new Response(status === 204 || status >= 300 ? null : "ok", { status, headers });
	Object.defineProperty(res, "url", { value: url });
	return res;
}

/** The redirect-following loop from `createHttpAccess`, minus the host checks a unit test cannot run. */
function followsManually() {
	return {
		async fetch(url: string, init?: RequestInit): Promise<Response> {
			let current = url;
			for (let i = 0; i <= 5; i++) {
				const response = await globalThis.fetch(current, { ...init, redirect: "manual" });
				if (response.status < 300 || response.status >= 400) return response;
				const location = response.headers.get("Location");
				if (!location) return response;
				current = new URL(location, current).href;
			}
			throw new Error("too many redirects");
		},
	};
}

function context() {
	const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const ctx = {
		input: { formId: "contact", data: { email: "someone@example.test" } },
		storage: {
			forms: {
				get: async (id: string) => (id === "contact" ? form() : null),
				put: async () => {},
				query: async () => ({ items: [{ id: "contact", data: form() }] }),
			},
			submissions: {
				put: async () => {},
				get: async () => null,
				count: async () => 1,
				query: async () => ({ items: [] }),
			},
		},
		kv: { get: async () => null, set: async () => {} },
		log,
		http: followsManually(),
		media: undefined,
		email: undefined,
		requestMeta: { ip: "203.0.113.1", userAgent: "test", referer: null, headers: {} },
	};
	return { ctx, log };
}

describe("submission webhook", () => {
	const realFetch = globalThis.fetch;
	beforeEach(() => vi.clearAllMocks());
	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("logs a 5xx, which fetch resolves rather than rejects", async () => {
		globalThis.fetch = vi.fn(async (u: string) => reply(u, 500)) as typeof fetch;
		const { ctx, log } = context();
		const result = await submitHandler(ctx as never);
		await settle();

		expect(result.success).toBe(true); // the visitor is never shown the webhook's problem
		expect(log.error).toHaveBeenCalledWith("Webhook failed", { url: WEBHOOK, status: 500 });
	});

	it("logs an auth wall that answers 200 from a different URL", async () => {
		// What the wrapper actually does: a 302, then it follows to the sign-in page itself.
		globalThis.fetch = vi.fn(async (u: string) =>
			u === WEBHOOK ? reply(WEBHOOK, 302, { Location: LOGIN }) : reply(LOGIN, 200),
		) as typeof fetch;
		const { ctx, log } = context();
		await submitHandler(ctx as never);
		await settle();

		expect(log.warn).toHaveBeenCalledWith("Webhook was redirected", {
			url: WEBHOOK,
			finalUrl: LOGIN,
		});
		expect(log.error).not.toHaveBeenCalled();
	});

	it("says nothing about a redirect that lands on the same endpoint", async () => {
		globalThis.fetch = vi.fn(async (u: string) =>
			u === WEBHOOK ? reply(WEBHOOK, 301, { Location: `${WEBHOOK}/` }) : reply(`${WEBHOOK}/`, 200),
		) as typeof fetch;
		const { ctx, log } = context();
		await submitHandler(ctx as never);
		await settle();

		expect(log.warn).not.toHaveBeenCalled();
		expect(log.error).not.toHaveBeenCalled();
	});

	it("logs a transport error", async () => {
		globalThis.fetch = vi.fn(async () => {
			throw new Error("boom");
		}) as typeof fetch;
		const { ctx, log } = context();
		await submitHandler(ctx as never);
		await settle();

		expect(log.error).toHaveBeenCalledWith("Webhook failed", {
			url: WEBHOOK,
			error: "Error: boom",
		});
	});

	it("says nothing when the webhook succeeds, and still calls it", async () => {
		const spy = vi.fn(async (u: string) => reply(u, 200));
		globalThis.fetch = spy as typeof fetch;
		const { ctx, log } = context();
		await submitHandler(ctx as never);
		await settle();

		expect(spy).toHaveBeenCalledWith(WEBHOOK, expect.objectContaining({ method: "POST" }));
		expect(log.error).not.toHaveBeenCalled();
		expect(log.warn).not.toHaveBeenCalled();
	});
});
