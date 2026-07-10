/**
 * Readiness Probe Tests
 *
 * Regression coverage for the multi-plugin readiness probe. The original
 * implementation only probed the first plugin, so a downstream plugin
 * failing to bind would still be reported as ready, leaving subsequent
 * hook invocations to hang or hit ECONNREFUSED.
 */

import http from "node:http";
import type { AddressInfo } from "node:net";

import { describe, it, expect } from "vitest";

import { probeAllReady } from "../src/sandbox/runner.js";

type Behavior = "ready" | "not-ready" | "down";

interface FakeServer {
	port: number;
	close: () => Promise<void>;
}

function makeServer(behavior: Behavior): Promise<FakeServer> {
	return new Promise((resolve) => {
		const server = http.createServer((req, res) => {
			if (behavior === "ready" && req.url === "/__ready") {
				res.writeHead(200, { "Content-Type": "text/plain" }).end("ok");
			} else if (behavior === "not-ready" && req.url === "/__ready") {
				res.writeHead(503).end();
			} else {
				res.writeHead(404).end();
			}
		});
		if (behavior === "down") {
			// Listen briefly to get a free port, then close so nothing is on it.
			server.listen(0, "127.0.0.1", () => {
				const port = (server.address() as AddressInfo).port;
				server.close(() => resolve({ port, close: async () => {} }));
			});
			return;
		}
		server.listen(0, "127.0.0.1", () => {
			const port = (server.address() as AddressInfo).port;
			resolve({
				port,
				close: () => new Promise<void>((r) => server.close(() => r())),
			});
		});
	});
}

describe("probeAllReady", () => {
	it("returns true when all plugins are ready", async () => {
		const a = await makeServer("ready");
		const b = await makeServer("ready");
		try {
			expect(await probeAllReady([{ port: a.port }, { port: b.port }], "tok")).toBe(true);
		} finally {
			await a.close();
			await b.close();
		}
	});

	it("returns false when any plugin is not ready", async () => {
		const a = await makeServer("ready");
		const b = await makeServer("not-ready");
		try {
			expect(await probeAllReady([{ port: a.port }, { port: b.port }], "tok")).toBe(false);
		} finally {
			await a.close();
			await b.close();
		}
	});

	it("returns false when any plugin is unreachable", async () => {
		const a = await makeServer("ready");
		const b = await makeServer("down");
		try {
			expect(await probeAllReady([{ port: a.port }, { port: b.port }], "tok", 200)).toBe(false);
		} finally {
			await a.close();
		}
	});

	it("returns true when plugin list is empty", async () => {
		expect(await probeAllReady([], "tok")).toBe(true);
	});
});
