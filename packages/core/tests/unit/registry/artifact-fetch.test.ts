import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createWorkersRegistryArtifactTransport,
	fetchRegistryArtifactUrl,
	setDefaultRegistryArtifactTransport,
	type RegistryArtifactTransport,
} from "../../../src/registry/artifact-fetch.js";
import { setDefaultDnsResolver } from "../../../src/security/ssrf.js";

describe("registry artifact fetch", () => {
	afterEach(() => {
		setDefaultDnsResolver(null);
		setDefaultRegistryArtifactTransport(null);
	});

	it("connects to the exact public address returned by validation", async () => {
		setDefaultDnsResolver(async () => ["203.0.113.10", "2001:db8::10"]);
		const fetch = vi.fn<RegistryArtifactTransport["fetch"]>(async (input) => ({
			response: new Response("artifact"),
			connectedAddress: input.allowedAddresses[1]!,
		}));
		setDefaultRegistryArtifactTransport({ fetch });

		const response = await fetchRegistryArtifactUrl("https://cdn.example/artifact.tgz", {
			signal: new AbortController().signal,
			maxResponseBytes: 1024,
		});

		expect(await response.text()).toBe("artifact");
		expect(fetch).toHaveBeenCalledOnce();
		expect(fetch.mock.calls[0]![0]).toMatchObject({
			url: new URL("https://cdn.example/artifact.tgz"),
			allowedAddresses: ["203.0.113.10", "2001:db8::10"],
			maxResponseBytes: 1024,
		});
	});

	it("rejects a transport that connected outside the validated address set", async () => {
		setDefaultDnsResolver(async () => ["203.0.113.10"]);
		const cancel = vi.fn(async () => undefined);
		setDefaultRegistryArtifactTransport({
			async fetch() {
				return {
					response: {
						body: { cancel },
					} as unknown as Response,
					connectedAddress: "127.0.0.1",
				};
			},
		});

		await expect(
			fetchRegistryArtifactUrl("https://cdn.example/artifact.tgz", {
				signal: new AbortController().signal,
				maxResponseBytes: 1024,
			}),
		).rejects.toThrow("outside the validated address set");
		expect(cancel).toHaveBeenCalledOnce();
	});

	it("rejects non-address resolver output before the transport can resolve it again", async () => {
		setDefaultDnsResolver(async () => ["second-lookup.example"]);
		const fetch = vi.fn<RegistryArtifactTransport["fetch"]>();
		setDefaultRegistryArtifactTransport({ fetch });

		await expect(
			fetchRegistryArtifactUrl("https://cdn.example/artifact.tgz", {
				signal: new AbortController().signal,
				maxResponseBytes: 1024,
			}),
		).rejects.toThrow("non-IP address");
		expect(fetch).not.toHaveBeenCalled();
	});

	it("uses a Worker TLS socket connected to the approved IP while preserving hostname identity", async () => {
		const requestBytes: Uint8Array[] = [];
		const responseBytes = new TextEncoder().encode(
			"HTTP/1.1 200 OK\r\nContent-Length: 8\r\nContent-Type: text/plain\r\n\r\nartifact",
		);
		const close = vi.fn(async () => undefined);
		const tlsSocket = {
			opened: Promise.resolve(),
			readable: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(responseBytes);
					controller.close();
				},
			}),
			writable: new WritableStream<Uint8Array>({
				write(bytes) {
					requestBytes.push(bytes);
				},
			}),
			startTls: vi.fn(),
			close,
		};
		const startTls = vi.fn(() => tlsSocket);
		const rawSocket = {
			opened: Promise.resolve(),
			readable: new ReadableStream<Uint8Array>(),
			writable: new WritableStream<Uint8Array>(),
			startTls,
			close,
		};
		const connect = vi.fn(() => rawSocket);
		const transport = createWorkersRegistryArtifactTransport(connect);

		const result = await transport.fetch({
			url: new URL("https://cdn.example/artifact.tgz?release=1"),
			allowedAddresses: ["203.0.113.10"],
			signal: new AbortController().signal,
			maxResponseBytes: 1024,
		});

		expect(connect).toHaveBeenCalledWith(
			{ hostname: "203.0.113.10", port: 443 },
			{ secureTransport: "starttls", allowHalfOpen: false },
		);
		expect(startTls).toHaveBeenCalledWith({ expectedServerHostname: "cdn.example" });
		expect(new TextDecoder().decode(requestBytes[0])).toContain(
			"GET /artifact.tgz?release=1 HTTP/1.1\r\nHost: cdn.example\r\n",
		);
		expect(result.connectedAddress).toBe("203.0.113.10");
		expect(await result.response.text()).toBe("artifact");
	});
});
