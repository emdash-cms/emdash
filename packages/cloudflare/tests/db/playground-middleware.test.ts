import { beforeEach, describe, expect, it, vi } from "vitest";

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

	return {
		after,
		anchored,
		initializePlayground,
		isReady,
		query,
		namespace: {
			idFromName: vi.fn((token: string) => token),
			get: vi.fn(() => stub),
		},
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
	env: { PLAYGROUND_DB: mocks.namespace },
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

async function requestPlayground(token: string): Promise<Response> {
	const response = await onRequest(
		{
			url: new URL("https://example.com/playground"),
			request: new Request("https://example.com/playground"),
			cookies: {
				get: (name: string) => (name === "emdash_playground" ? { value: token } : undefined),
				set: vi.fn(),
			},
			locals: {},
			redirect: (location: string) => new Response(null, { status: 302, headers: { location } }),
		} as never,
		vi.fn() as never,
	);

	if (!(response instanceof Response)) throw new Error("Expected a playground response");
	return response;
}

describe("playground initialization endpoint", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.anchored.length = 0;
		mocks.initializePlayground.mockImplementation(() => progressStream(SUCCESS_PROGRESS));
		mocks.isReady.mockResolvedValue(false);
		mocks.query.mockResolvedValue({ rows: [], changes: 1 });
	});

	it("proxies the Durable Object's initialization milestones", async () => {
		const response = await requestInit("progress-success", PROGRESS_TYPE);

		expect(response.headers.get("content-type")).toContain(PROGRESS_TYPE);
		expect(await response.text()).toBe(SUCCESS_PROGRESS);
		expect(mocks.initializePlayground).toHaveBeenCalledWith(3600);
	});

	it("proxies initialization failures in the NDJSON stream", async () => {
		mocks.initializePlayground.mockReturnValueOnce(progressStream(ERROR_PROGRESS));

		const response = await requestInit("migration-failure", PROGRESS_TYPE);

		expect(await response.text()).toBe(ERROR_PROGRESS);
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

	it("checks durable readiness instead of retaining an initialized session token", async () => {
		await requestInit("expired-session");
		mocks.isReady.mockResolvedValue(false);

		const response = await requestPlayground("expired-session");

		expect(response.status).toBe(200);
		expect(mocks.isReady).toHaveBeenCalledTimes(1);
	});
});
