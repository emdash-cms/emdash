import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startCloudflareDevScheduler } from "../../../../src/astro/integration/cloudflare-dev-scheduler.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("Cloudflare dev scheduler", () => {
	function createServer() {
		return Object.assign(new EventEmitter(), {
			address: () => ({ address: "127.0.0.1", family: "IPv4", port: 4323 }),
		});
	}

	it("drives the Worker scheduled handler from the long-lived dev server", async () => {
		vi.useFakeTimers();
		const httpServer = createServer();
		const fetchScheduled = vi.fn(async () => new Response(null, { status: 200 }));
		const warn = vi.fn();

		startCloudflareDevScheduler(
			{ httpServer: httpServer as never },
			{ warn },
			{ intervalMs: 1_000, fetch: fetchScheduled },
		);
		httpServer.emit("listening");

		await vi.advanceTimersByTimeAsync(999);
		expect(fetchScheduled).not.toHaveBeenCalled();

		await vi.advanceTimersByTimeAsync(1);
		expect(fetchScheduled).toHaveBeenCalledOnce();
		const url = new URL(String(fetchScheduled.mock.calls[0]?.[0]));
		expect(url.origin).toBe("http://localhost:4323");
		expect(url.pathname).toBe("/cdn-cgi/handler/scheduled");
		expect(url.searchParams.get("cron")).toBe("* * * * *");
		expect(url.searchParams.get("format")).toBe("json");
		expect(warn).not.toHaveBeenCalled();

		httpServer.emit("close");
		await vi.advanceTimersByTimeAsync(2_000);
		expect(fetchScheduled).toHaveBeenCalledOnce();
	});

	it("reports a missing scheduled handler and keeps polling", async () => {
		vi.useFakeTimers();
		const httpServer = createServer();
		const fetchScheduled = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 404 }))
			.mockResolvedValue(new Response(null, { status: 200 }));
		const warn = vi.fn();

		startCloudflareDevScheduler(
			{ httpServer: httpServer as never },
			{ warn },
			{ intervalMs: 1_000, fetch: fetchScheduled },
		);
		httpServer.emit("listening");

		await vi.advanceTimersByTimeAsync(1_000);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("status 404"));

		await vi.advanceTimersByTimeAsync(1_000);
		expect(fetchScheduled).toHaveBeenCalledTimes(2);
	});
});
