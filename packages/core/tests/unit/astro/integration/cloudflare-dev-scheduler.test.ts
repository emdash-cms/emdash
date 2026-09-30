import { execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { startCloudflareDevScheduler } from "../../../../src/astro/integration/cloudflare-dev-scheduler.js";

afterEach(() => {
	vi.useRealTimers();
});

describe("Cloudflare dev scheduler", () => {
	it.each([
		{ matching: true, format: "unconfigured" },
		{ matching: true, format: "pem" },
		{ matching: false, format: "pem" },
		{ matching: true, format: "pfx" },
		{ matching: false, format: "pfx" },
	])(
		"handles HTTPS with $format certificate options (matching: $matching)",
		async ({ matching, format }) => {
			const root = mkdtempSync(join(tmpdir(), "emdash-dev-tls-"));
			const configPath = join(root, "openssl.cnf");
			writeFileSync(
				configPath,
				"[req]\ndistinguished_name=dn\n[dn]\n[test]\nsubjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n",
			);
			function certificate(name: string) {
				const keyPath = join(root, `${name}.key`);
				const certPath = join(root, `${name}.pem`);
				execFileSync(
					"openssl",
					[
						"req",
						"-x509",
						"-newkey",
						"ec",
						"-pkeyopt",
						"ec_paramgen_curve:P-256",
						"-nodes",
						"-days",
						"1",
						"-subj",
						"/CN=127.0.0.1",
						"-config",
						configPath,
						"-extensions",
						"test",
						"-keyout",
						keyPath,
						"-out",
						certPath,
					],
					{ stdio: "ignore" },
				);
				const pfxPath = join(root, `${name}.pfx`);
				execFileSync(
					"openssl",
					[
						"pkcs12",
						"-export",
						"-in",
						certPath,
						"-inkey",
						keyPath,
						"-out",
						pfxPath,
						"-passout",
						"pass:synthetic-test-only",
					],
					{ stdio: "ignore" },
				);
				return {
					key: readFileSync(keyPath),
					cert: readFileSync(certPath),
					pfx: readFileSync(pfxPath),
				};
			}
			const served = certificate("served");
			const trusted = matching ? served : certificate("other");
			let maintenanceRequests = 0;
			const httpServer = createHttpsServer(
				{ key: served.key, cert: served.cert },
				(request, response) => {
					if (request.url === "/_emdash/api/dev/scheduled-tasks" && request.method === "POST") {
						maintenanceRequests++;
					}
					response.writeHead(204).end();
				},
			);
			const server = {
				httpServer,
				resolvedUrls: { local: [] as string[], network: [] },
				config: {
					server: {
						https:
							format === "pfx"
								? { pfx: trusted.pfx, passphrase: "synthetic-test-only" }
								: format === "unconfigured"
									? {}
									: { cert: trusted.cert },
					},
				},
			};
			const warn = vi.fn();
			startCloudflareDevScheduler(server, { warn }, { intervalMs: 25 });
			try {
				await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
				const address = httpServer.address();
				if (!address || typeof address === "string") throw new Error("Expected a TCP address");
				server.resolvedUrls.local.push(`https://127.0.0.1:${address.port}`);
				if (matching) {
					await vi.waitFor(() => expect(maintenanceRequests).toBeGreaterThan(0));
					expect(warn).not.toHaveBeenCalled();
				} else {
					await vi.waitFor(() => expect(warn).toHaveBeenCalled());
					expect(maintenanceRequests).toBe(0);
				}
			} finally {
				await new Promise<void>((resolve) => httpServer.close(() => resolve()));
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	it("keeps issuing maintenance requests after the initial HTTP response completes", async () => {
		let maintenanceRequests = 0;
		let applicationScheduledRequests = 0;
		const httpServer = createHttpServer((request, response) => {
			if (request.url === "/_emdash/api/dev/scheduled-tasks" && request.method === "POST") {
				maintenanceRequests++;
			}
			if (request.url?.startsWith("/cdn-cgi/handler/scheduled")) {
				applicationScheduledRequests++;
			}
			response.writeHead(204).end();
		});
		const server = { httpServer, resolvedUrls: { local: [] as string[], network: [] } };
		const warn = vi.fn();
		startCloudflareDevScheduler(server, { warn }, { intervalMs: 25 });

		try {
			await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
			const address = httpServer.address();
			if (!address || typeof address === "string") throw new Error("Expected a TCP address");
			const origin = `http://127.0.0.1:${address.port}`;
			server.resolvedUrls.local.push(origin);
			const initialResponse = await fetch(origin);
			await initialResponse.arrayBuffer();
			const requestsAfterInitialResponse = maintenanceRequests;

			await vi.waitFor(() => {
				expect(maintenanceRequests).toBeGreaterThanOrEqual(requestsAfterInitialResponse + 2);
			});
			expect(applicationScheduledRequests).toBe(0);
			expect(warn).not.toHaveBeenCalled();
		} finally {
			await new Promise<void>((resolve, reject) => {
				httpServer.close((error) => {
					if (error) {
						reject(error);
						return;
					}
					resolve();
				});
			});
		}
	});

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

	it.each(["/docs/", "/docs", "/nested/docs/"])("preserves the dev base path %s", async (base) => {
		vi.useFakeTimers();
		const httpServer = createServer(`https://dev.example.test:7443${base}`);
		const fetchScheduled = vi.fn(async () => new Response(null, { status: 204 }));
		startCloudflareDevScheduler(
			{ httpServer: httpServer as never, resolvedUrls: httpServer.resolvedUrls },
			{ warn: vi.fn() },
			{ intervalMs: 1_000, fetch: fetchScheduled },
		);
		httpServer.emit("listening");
		await vi.advanceTimersByTimeAsync(1_000);
		expect(String(fetchScheduled.mock.calls[0]?.[0])).toBe(
			`https://dev.example.test:7443${base.replace(/\/$/, "")}/_emdash/api/dev/scheduled-tasks`,
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
