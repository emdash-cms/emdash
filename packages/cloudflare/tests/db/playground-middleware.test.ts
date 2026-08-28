import { ulid } from "ulidx";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const anchored: Promise<void>[] = [];
	const after = vi.fn((fn: () => void | Promise<void>) => {
		const task = Promise.resolve().then(fn);
		anchored.push(task);
	});
	const initializePlayground = vi.fn();
	const isReady = vi.fn();
	const query = vi.fn();
	const stub = { initializePlayground, isReady, query };
	const namespace = {
		idFromName: vi.fn((token: string) => token),
		get: vi.fn(() => stub),
	};
	const workerEnv: Record<string, unknown> = { PLAYGROUND_DB: namespace };

	return {
		after,
		anchored,
		initializePlayground,
		isReady,
		query,
		namespace,
		workerEnv,
	};
});

vi.mock("astro:middleware", () => ({
	defineMiddleware: (handler: unknown) => handler,
}));
vi.mock("cloudflare:workers", () => ({
	DurableObject: class {
		ctx: unknown;

		constructor(ctx: unknown) {
			this.ctx = ctx;
		}
	},
	env: mocks.workerEnv,
}));
vi.mock("virtual:emdash/config", () => ({
	default: { database: { config: { binding: "PLAYGROUND_DB" } } },
}));
vi.mock("emdash", () => ({ after: mocks.after }));

import { onRequest } from "../../src/db/playground-middleware.js";

const PROGRESS_TYPE = "application/x-ndjson";
const SUCCESS_PROGRESS = '{"step":"database"}\n{"step":"content"}\n{"step":"ready"}\n';
const ERROR_PROGRESS =
	'{"error":{"code":"PLAYGROUND_INIT_ERROR","message":"Failed to initialize playground"}}\n';

function progressStream(body: string): ReadableStream<Uint8Array> {
	return new Response(body).body!;
}

async function requestInit(token: string, accept?: string): Promise<Response> {
	const response = await onRequest(
		{
			url: new URL("https://example.com/_playground/init"),
			request: new Request("https://example.com/_playground/init", {
				method: "POST",
				headers: accept ? { accept } : undefined,
			}),
			cookies: {
				get: (name: string) => (name === "emdash_playground" ? { value: token } : undefined),
			},
			locals: {},
		} as never,
		vi.fn() as never,
	);

	if (!(response instanceof Response)) throw new Error("Expected an initialization response");
	return response;
}

async function requestPlayground(
	token?: string,
): Promise<{ response: Response; setCookie: ReturnType<typeof vi.fn> }> {
	const setCookie = vi.fn();
	const response = await onRequest(
		{
			url: new URL("https://example.com/playground"),
			request: new Request("https://example.com/playground"),
			cookies: {
				get: (name: string) =>
					name === "emdash_playground" && token ? { value: token } : undefined,
				set: setCookie,
			},
			locals: {},
			redirect: (location: string) => new Response(null, { status: 302, headers: { location } }),
		} as never,
		vi.fn() as never,
	);

	if (!(response instanceof Response)) throw new Error("Expected a playground response");
	return { response, setCookie };
}

async function requestPage(token: string): Promise<Response> {
	const response = await onRequest(
		{
			url: new URL("https://example.com/_emdash/admin"),
			request: new Request("https://example.com/_emdash/admin"),
			cookies: {
				get: (name: string) => (name === "emdash_playground" ? { value: token } : undefined),
			},
			locals: {},
		} as never,
		() => Promise.resolve(new Response("ok")),
	);

	if (!(response instanceof Response)) throw new Error("Expected a page response");
	return response;
}

describe("playground initialization endpoint", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.anchored.length = 0;
		mocks.workerEnv.PLAYGROUND_DB = mocks.namespace;
		mocks.initializePlayground.mockImplementation(() => progressStream(SUCCESS_PROGRESS));
		mocks.isReady.mockResolvedValue(false);
		mocks.query.mockResolvedValue({ rows: [], changes: 1 });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("proxies the Durable Object's initialization milestones", async () => {
		const response = await requestInit("progress-success", PROGRESS_TYPE);

		expect(response.headers.get("content-type")).toContain(PROGRESS_TYPE);
		expect(await response.text()).toBe(SUCCESS_PROGRESS);
		expect(mocks.initializePlayground).toHaveBeenCalledWith(3600);
	});

	it("proxies initialization failures in the NDJSON stream", async () => {
		mocks.initializePlayground.mockReturnValueOnce(progressStream(ERROR_PROGRESS));
		const token = ulid();

		const response = await requestInit(token, PROGRESS_TYPE);

		expect(await response.text()).toBe(ERROR_PROGRESS);
		await Promise.all(mocks.anchored);
		mocks.isReady.mockResolvedValue(true);
		await requestPage(token);
		expect(mocks.isReady).toHaveBeenCalledTimes(1);
	});

	it("preserves the JSON response for clients that do not request progress", async () => {
		const response = await requestInit("json-success");

		expect(response.headers.get("content-type")).toContain("application/json");
		expect(await response.json()).toEqual({ ok: true });
		expect(mocks.after).toHaveBeenCalledTimes(1);
		await Promise.all(mocks.anchored);
	});

	it("returns the legacy JSON error when Durable Object initialization fails", async () => {
		mocks.initializePlayground.mockReturnValueOnce(progressStream(ERROR_PROGRESS));

		const response = await requestInit("json-failure");

		expect(response.status).toBe(500);
		expect(await response.json()).toEqual({
			error: {
				code: "PLAYGROUND_INIT_ERROR",
				message: "Failed to initialize playground",
			},
		});
	});

	it("anchors a drain when proxying progress so client cancellation leaves the RPC consumed", async () => {
		let controller!: ReadableStreamDefaultController<Uint8Array>;
		const cancel = vi.fn();
		mocks.initializePlayground.mockReturnValueOnce(
			new ReadableStream<Uint8Array>({
				start(value) {
					controller = value;
				},
				cancel,
			}),
		);

		const response = await requestInit("disconnected", PROGRESS_TYPE);
		expect(mocks.after).toHaveBeenCalledTimes(1);
		const clientCancellation = response.body!.cancel();
		controller.enqueue(new TextEncoder().encode(SUCCESS_PROGRESS));
		controller.close();

		await Promise.all([clientCancellation, ...mocks.anchored]);
		expect(cancel).not.toHaveBeenCalled();
	});

	it("does not cache readiness for invalid session tokens", async () => {
		await requestInit("invalid-session");
		mocks.isReady.mockResolvedValue(false);

		const { response } = await requestPlayground("invalid-session");

		expect(response.status).toBe(200);
		expect(mocks.isReady).toHaveBeenCalledTimes(1);
	});

	it("does not cache readiness for future session tokens", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-28T10:00:00Z"));
		const token = ulid(Date.now() + 1_000);
		const response = await requestInit(token, PROGRESS_TYPE);

		await response.text();
		await Promise.all(mocks.anchored);
		mocks.isReady.mockResolvedValue(true);
		await requestPage(token);

		expect(mocks.isReady).toHaveBeenCalledTimes(1);
	});

	it("does not check durable readiness for a new session", async () => {
		const { response, setCookie } = await requestPlayground();

		expect(response.status).toBe(200);
		expect(setCookie).toHaveBeenCalledWith(
			"emdash_playground",
			expect.any(String),
			expect.objectContaining({ maxAge: 3600 }),
		);
		expect(mocks.isReady).not.toHaveBeenCalled();
	});

	it("caches readiness after streamed initialization", async () => {
		const token = ulid();
		const response = await requestInit(token, PROGRESS_TYPE);

		await response.text();
		await Promise.all(mocks.anchored);
		await requestPage(token);
		await requestPage(token);

		expect(mocks.isReady).not.toHaveBeenCalled();
	});

	it("rechecks durable readiness after the session TTL", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-08-28T10:00:00Z"));
		const token = ulid(Date.now());
		mocks.isReady.mockResolvedValue(true);

		await requestPage(token);
		await requestPage(token);
		expect(mocks.isReady).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(3_600_001);
		await requestPage(token);
		expect(mocks.isReady).toHaveBeenCalledTimes(2);
	});

	it("rechecks durable readiness when the binding changes", async () => {
		const token = ulid();
		mocks.isReady.mockResolvedValue(true);
		await requestPage(token);

		const replacementIsReady = vi.fn().mockResolvedValue(true);
		mocks.workerEnv.PLAYGROUND_DB = {
			idFromName: vi.fn((value: string) => value),
			get: vi.fn(() => ({
				initializePlayground: mocks.initializePlayground,
				isReady: replacementIsReady,
				query: mocks.query,
			})),
		};

		await requestPage(token);

		expect(replacementIsReady).toHaveBeenCalledTimes(1);
	});
});
