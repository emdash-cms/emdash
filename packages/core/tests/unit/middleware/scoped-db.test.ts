import { describe, it, expect, vi } from "vitest";

import {
	ASTRO_COOKIES_SYMBOL,
	finishScoped,
	wrapResponseForScopedClose,
} from "../../../src/astro/middleware/scoped-db.js";

/** Build a streaming Response whose body emits the given chunks. */
function streamingResponse(chunks: string[], init?: ResponseInit): Response {
	const encoder = new TextEncoder();
	const body = new ReadableStream<Uint8Array>({
		start(controller) {
			for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
			controller.close();
		},
	});
	return new Response(body, init);
}

/** Fully drain a response body so any stream-end hooks fire. */
async function drain(response: Response): Promise<string> {
	return response.body ? await new Response(response.body).text() : "";
}

describe("wrapResponseForScopedClose", () => {
	it("closes immediately for a bodyless response", () => {
		const close = vi.fn();
		const response = new Response(null, { status: 302, headers: { location: "/" } });

		const wrapped = wrapResponseForScopedClose(response, close);

		expect(close).toHaveBeenCalledTimes(1);
		// Bodyless responses pass through unchanged.
		expect(wrapped).toBe(response);
	});

	it("defers close until the body has fully streamed", async () => {
		const close = vi.fn();
		const wrapped = wrapResponseForScopedClose(streamingResponse(["a", "b"]), close);

		// Not closed yet — the body hasn't been read.
		expect(close).not.toHaveBeenCalled();

		const text = await drain(wrapped);

		expect(text).toBe("ab");
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("closes when the body stream is cancelled (client disconnect)", async () => {
		const close = vi.fn();
		const wrapped = wrapResponseForScopedClose(streamingResponse(["chunk"]), close);

		await wrapped.body!.cancel();

		expect(close).toHaveBeenCalledTimes(1);
	});

	it("is idempotent across flush and cancel", async () => {
		const close = vi.fn();
		const wrapped = wrapResponseForScopedClose(streamingResponse(["x"]), close);

		await drain(wrapped);
		await wrapped.body!.cancel().catch(() => {});

		expect(close).toHaveBeenCalledTimes(1);
	});

	it("swallows a throwing close so the stream still completes", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const close = vi.fn(() => {
			throw new Error("boom");
		});
		const wrapped = wrapResponseForScopedClose(streamingResponse(["data"]), close);

		const text = await drain(wrapped);

		expect(text).toBe("data");
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("forwards the Astro cookies symbol onto the wrapped response", async () => {
		const close = vi.fn();
		const response = streamingResponse(["hi"]);
		const cookies = { marker: true };
		Reflect.set(response, ASTRO_COOKIES_SYMBOL, cookies);

		const wrapped = wrapResponseForScopedClose(response, close);

		expect(Reflect.get(wrapped, ASTRO_COOKIES_SYMBOL)).toBe(cookies);
		await drain(wrapped);
	});

	it("drops a stale Content-Length on the wrapped streaming response", () => {
		const close = vi.fn();
		const response = streamingResponse(["hello"], { headers: { "content-length": "5" } });

		const wrapped = wrapResponseForScopedClose(response, close);

		expect(wrapped.headers.has("content-length")).toBe(false);
	});
});

describe("finishScoped", () => {
	it("commits then defers close to stream-end for a streaming response", async () => {
		const order: string[] = [];
		const commit = vi.fn(() => order.push("commit"));
		const close = vi.fn(() => order.push("close"));

		const response = await finishScoped({ commit, close }, async () => streamingResponse(["body"]));

		// commit runs before the response is returned; close is still pending.
		expect(commit).toHaveBeenCalledTimes(1);
		expect(close).not.toHaveBeenCalled();

		await drain(response);

		expect(close).toHaveBeenCalledTimes(1);
		expect(order).toEqual(["commit", "close"]);
	});

	it("commits and closes immediately when there is no body", async () => {
		const commit = vi.fn();
		const close = vi.fn();

		await finishScoped({ commit, close }, async () => new Response(null, { status: 204 }));

		expect(commit).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("passes the response through unchanged for adapters without close (D1)", async () => {
		const commit = vi.fn();
		const original = streamingResponse(["d1"]);

		const result = await finishScoped({ commit }, async () => original);

		expect(result).toBe(original);
		expect(commit).toHaveBeenCalledTimes(1);
	});

	it("commits and closes once before rethrowing when run() throws", async () => {
		const commit = vi.fn();
		const close = vi.fn();
		const boom = new Error("render failed");

		await expect(
			finishScoped({ commit, close }, async () => {
				throw boom;
			}),
		).rejects.toBe(boom);

		expect(commit).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
	});

	it("still closes the connection when commit() throws on the success path", async () => {
		// Regression: a previous version called commit() unguarded on the
		// success path, so a throwing commit skipped close() and leaked the
		// connection.
		const close = vi.fn();
		const commit = vi.fn(() => {
			throw new Error("commit failed");
		});

		await expect(
			finishScoped({ commit, close }, async () => streamingResponse(["body"])),
		).rejects.toThrow("commit failed");

		expect(close).toHaveBeenCalledTimes(1);
	});

	it("does not mask a run() error when commit() also throws on the error path", async () => {
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const close = vi.fn();
		const commit = vi.fn(() => {
			throw new Error("commit failed");
		});
		const renderError = new Error("render failed");

		await expect(
			finishScoped({ commit, close }, async () => {
				throw renderError;
			}),
		).rejects.toBe(renderError);

		// close still runs even though commit threw during error handling.
		expect(close).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("does not mask a run() error when close() throws on the error path", async () => {
		// Regression: close() on the error path was unguarded, so a throwing
		// teardown would replace the render error the caller needs to see.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const commit = vi.fn();
		const close = vi.fn(() => {
			throw new Error("close failed");
		});
		const renderError = new Error("render failed");

		await expect(
			finishScoped({ commit, close }, async () => {
				throw renderError;
			}),
		).rejects.toBe(renderError);

		expect(commit).toHaveBeenCalledTimes(1);
		expect(close).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});

	it("surfaces the commit error, not a later close error, on the success path", async () => {
		// When commit() fails after a successful render, the caller must see the
		// commit failure; a throwing close() during cleanup must not mask it.
		const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
		const commit = vi.fn(() => {
			throw new Error("commit failed");
		});
		const close = vi.fn(() => {
			throw new Error("close failed");
		});

		await expect(
			finishScoped({ commit, close }, async () => streamingResponse(["body"])),
		).rejects.toThrow("commit failed");

		expect(close).toHaveBeenCalledTimes(1);
		expect(errorSpy).toHaveBeenCalled();
		errorSpy.mockRestore();
	});
});
