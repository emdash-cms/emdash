import { describe, it, expect, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

vi.mock(
	"virtual:emdash/config",
	() => ({
		default: {
			database: { config: {} },
			auth: { mode: "none" },
		},
	}),
	{ virtual: true },
);

vi.mock(
	"virtual:emdash/dialect",
	() => ({
		createDialect: vi.fn(),
		isSessionEnabled: vi.fn().mockReturnValue(false),
		getD1Binding: vi.fn(),
		getDefaultConstraint: vi.fn().mockReturnValue("first-unconstrained"),
		getBookmarkCookieName: vi.fn().mockReturnValue("emdash-bookmark"),
		createSessionDialect: vi.fn(),
	}),
	{ virtual: true },
);

vi.mock("virtual:emdash/media-providers", () => ({ mediaProviders: [] }), { virtual: true });
vi.mock("virtual:emdash/plugins", () => ({ plugins: [] }), { virtual: true });
vi.mock(
	"virtual:emdash/sandbox-runner",
	() => ({
		createSandboxRunner: null,
		sandboxEnabled: false,
	}),
	{ virtual: true },
);
vi.mock("virtual:emdash/sandboxed-plugins", () => ({ sandboxedPlugins: [] }), { virtual: true });
vi.mock("virtual:emdash/storage", () => ({ createStorage: null }), { virtual: true });

vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(async () => ({
		selectFrom: () => ({
			selectAll: () => ({
				limit: () => ({
					execute: async () => [],
				}),
			}),
		}),
	})),
}));

import { createSessionDialect, getD1Binding, isSessionEnabled } from "virtual:emdash/dialect";

import onRequest from "../../../src/astro/middleware.js";

describe("astro middleware prerendered routes", () => {
	it("does not access session on prerendered public runtime routes", async () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
		try {
			vi.mocked(isSessionEnabled).mockReturnValue(true);
			vi.mocked(getD1Binding).mockReturnValue({
				withSession: () => {
					throw new Error("withSession reached");
				},
			});
			vi.mocked(createSessionDialect).mockReturnValue(undefined as never);

			const cookies = {
				get: vi.fn(() => undefined),
			};

			const context: Record<string, unknown> = {
				request: new Request("https://example.com/robots.txt"),
				url: new URL("https://example.com/robots.txt"),
				cookies,
				locals: {},
				redirect: vi.fn(),
				isPrerendered: true,
			};

			Object.defineProperty(context, "session", {
				get() {
					throw new Error("session should not be accessed during prerender");
				},
			});

			await expect(
				onRequest(context as Parameters<typeof onRequest>[0], async () => new Response("ok")),
			).rejects.toThrow("withSession reached");
		} finally {
			consoleErrorSpy.mockRestore();
		}
	});

	it("does not access session when prerendering public pages", async () => {
		const cookies = {
			get: vi.fn(() => undefined),
		};
		const redirect = vi.fn(
			(location: string) => new Response(null, { status: 302, headers: { Location: location } }),
		);

		const context: Record<string, unknown> = {
			request: new Request("https://example.com/"),
			url: new URL("https://example.com/"),
			cookies,
			locals: {},
			redirect,
			isPrerendered: true,
		};

		Object.defineProperty(context, "session", {
			get() {
				throw new Error("session should not be accessed during prerender");
			},
		});

		const response = await onRequest(
			context as Parameters<typeof onRequest>[0],
			async () => new Response("ok"),
		);

		expect(response.status).toBe(200);
		expect(redirect).not.toHaveBeenCalled();
	});
});
