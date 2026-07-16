import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));

const { authenticate, getUserByEmail } = vi.hoisted(() => ({
	authenticate: vi.fn(async () => ({
		email: "admin@example.com",
		name: "Admin",
		role: 50,
		subject: "access-user",
	})),
	getUserByEmail: vi.fn(async () => ({
		id: "user-1",
		email: "admin@example.com",
		name: "Admin",
		role: 50,
		disabled: false,
	})),
}));

vi.mock("virtual:emdash/auth", () => ({ authenticate }), { virtual: true });
vi.mock("virtual:emdash/config", () => ({ default: {} }), { virtual: true });
vi.mock("@emdash-cms/auth/adapters/kysely", () => ({
	createKyselyAdapter: () => ({
		getUserByEmail,
		getUserById: vi.fn(async () => null),
	}),
}));
vi.mock("../../../src/astro/session-user.js", () => ({
	resolveSessionUser: vi.fn(async () => null),
}));

let onRequest: typeof import("../../../src/astro/middleware/auth.js").onRequest;

beforeAll(async () => {
	vi.stubEnv("DEV", false);
	({ onRequest } = await import("../../../src/astro/middleware/auth.js"));
});

// Restore env stubs so `import.meta.env.DEV` does not leak into other test
// files sharing this Vitest worker.
afterAll(() => {
	vi.unstubAllEnvs();
});

function createContext(path: string, isPublic: boolean) {
	const locals: Record<string, unknown> & { user?: { id: string; email: string } } = {
		emdash: {
			db: {},
			config: {
				auth: {
					type: "cloudflare-access",
					entrypoint: "@emdash-cms/cloudflare/auth",
					config: { teamDomain: "example.cloudflareaccess.com" },
				},
			},
			getPluginRouteMeta: vi.fn(() => ({ public: isPublic })),
		},
	};
	const url = new URL(path, "https://example.com");
	const session = { get: vi.fn(async () => null), set: vi.fn() };

	return {
		locals,
		session,
		context: {
			request: new Request(url, {
				headers: { "Cf-Access-Jwt-Assertion": "access-jwt" },
			}),
			url,
			locals,
			session,
			redirect: vi.fn(),
		},
	};
}

describe("external auth on plugin API routes", () => {
	beforeEach(() => {
		authenticate.mockClear();
		getUserByEmail.mockClear();
	});

	it("authenticates a private plugin route with the configured provider", async () => {
		const { context, locals, session } = createContext(
			"/_emdash/api/plugins/ai-search/config",
			false,
		);

		const response = await onRequest(context as never, async () =>
			locals.user ? new Response("ok") : new Response("Authentication required", { status: 401 }),
		);

		expect(response.status).toBe(200);
		expect(authenticate).toHaveBeenCalledOnce();
		expect(locals.user).toMatchObject({ id: "user-1", email: "admin@example.com" });
		expect(session.set).toHaveBeenCalledWith("user", { id: "user-1" });
	});

	it("returns an opaque response when external authentication fails", async () => {
		authenticate.mockRejectedValueOnce(new Error("sensitive provider details"));
		const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
		const { context } = createContext("/_emdash/api/plugins/ai-search/config", false);

		try {
			const response = await onRequest(context as never, async () => new Response("ok"));

			expect(response.status).toBe(401);
			expect(await response.text()).toBe("Authentication failed");
		} finally {
			consoleError.mockRestore();
		}
	});

	it("leaves explicitly public plugin routes unauthenticated", async () => {
		const { context } = createContext("/_emdash/api/plugins/ai-search/query", true);

		const response = await onRequest(context as never, async () => new Response("ok"));

		expect(response.status).toBe(200);
		expect(authenticate).not.toHaveBeenCalled();
	});
});
