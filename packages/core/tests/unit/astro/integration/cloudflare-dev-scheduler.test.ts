import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startCloudflareDevScheduler } from "../../../../src/astro/integration/cloudflare-dev-scheduler.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("Cloudflare dev scheduler", () => {
	function createServer(origin = "http://localhost:4323/") {
		return Object.assign(new EventEmitter(), {
			address: () => ({ address: "127.0.0.1", family: "IPv4", port: 4323 }),
			resolvedUrls: { local: [origin], network: [] },
		});
	}

	it("drives the EmDash maintenance bridge from the long-lived dev server", async () => {
		vi.useFakeTimers();
		const httpServer = createServer();
		const fetchScheduled = vi.fn(async () => new Response(null, { status: 200 }));
		const warn = vi.fn();

		startCloudflareDevScheduler(
			{ httpServer: httpServer as never, resolvedUrls: httpServer.resolvedUrls },
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
		expect(url.pathname).toBe("/_emdash/api/dev/scheduled-tasks");
		expect(url.search).toBe("");
		expect(fetchScheduled.mock.calls[0]?.[1]).toEqual({ method: "POST" });
		expect(warn).not.toHaveBeenCalled();

		httpServer.emit("close");
		await vi.advanceTimersByTimeAsync(2_000);
		expect(fetchScheduled).toHaveBeenCalledOnce();
	});

	it("uses Vite's resolved HTTPS origin instead of reconstructing localhost", async () => {
		vi.useFakeTimers();
		const httpServer = createServer("https://dev.example.test:7443/");
		const fetchScheduled = vi.fn(async () => new Response(null, { status: 204 }));

		startCloudflareDevScheduler(
			{ httpServer: httpServer as never, resolvedUrls: httpServer.resolvedUrls },
			{ warn: vi.fn() },
			{ intervalMs: 1_000, fetch: fetchScheduled },
		);
		httpServer.emit("listening");

		await vi.advanceTimersByTimeAsync(1_000);

		expect(String(fetchScheduled.mock.calls[0]?.[0])).toBe(
			"https://dev.example.test:7443/_emdash/api/dev/scheduled-tasks",
		);
	});

	it("does not dispatch custom generalCron or unrelated application scheduled jobs", async () => {
		vi.useFakeTimers();
		const httpServer = createServer();
		const runEmDashMaintenance = vi.fn(async () => {});
		const runApplicationScheduledHandler = vi.fn(async () => {});
		const fetchScheduled = vi.fn(async (input: URL | RequestInfo) => {
			const url = new URL(
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
			);
			if (url.pathname === "/cdn-cgi/handler/scheduled") {
				await runApplicationScheduledHandler(url.searchParams.get("cron"));
			} else if (url.pathname === "/_emdash/api/dev/scheduled-tasks") {
				await runEmDashMaintenance();
			}
			return new Response(null, { status: 204 });
		});

		startCloudflareDevScheduler(
			{ httpServer: httpServer as never, resolvedUrls: httpServer.resolvedUrls },
			{ warn: vi.fn() },
			{ intervalMs: 1_000, fetch: fetchScheduled },
		);
		httpServer.emit("listening");

		await vi.advanceTimersByTimeAsync(1_000);

		expect(runEmDashMaintenance).toHaveBeenCalledOnce();
		expect(runApplicationScheduledHandler).not.toHaveBeenCalled();
	});

	it("reports a missing maintenance bridge and keeps polling", async () => {
		vi.useFakeTimers();
		const httpServer = createServer();
		const fetchScheduled = vi
			.fn()
			.mockResolvedValueOnce(new Response(null, { status: 404 }))
			.mockResolvedValue(new Response(null, { status: 200 }));
		const warn = vi.fn();

		startCloudflareDevScheduler(
			{ httpServer: httpServer as never, resolvedUrls: httpServer.resolvedUrls },
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
