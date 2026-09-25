import { once } from "node:events";
import { createServer, request } from "node:https";
import { getDefaultAutoSelectFamily, setDefaultAutoSelectFamily } from "node:net";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createNodeRegistryArtifactTransport,
	createWorkersRegistryArtifactTransport,
	fetchRegistryArtifactUrl,
	setDefaultRegistryArtifactTransport,
	type RegistryArtifactTransport,
} from "../../../src/registry/artifact-fetch.js";
import { setDefaultDnsResolver } from "../../../src/security/ssrf.js";

// openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -days 36500
//   -subj /CN=registry.test -addext subjectAltName=DNS:registry.test
const REGISTRY_TEST_CERT = `-----BEGIN CERTIFICATE-----
MIIBoDCCAUegAwIBAgIUcY8HloTnuQV80StybqJ+RIsfirQwCgYIKoZIzj0EAwIw
GDEWMBQGA1UEAwwNcmVnaXN0cnkudGVzdDAgFw0yNjA5MjQxMzQ2MTlaGA8yMTI2
MDgzMTEzNDYxOVowGDEWMBQGA1UEAwwNcmVnaXN0cnkudGVzdDBZMBMGByqGSM49
AgEGCCqGSM49AwEHA0IABIGbggMJH2dzdBJhrr38dkT42RQYH2o0g1GRKEfIJCqV
XYmfzERgG2PKaFilbDdAhHY6PcDmd+T4Ru0NPZEsWVSjbTBrMB0GA1UdDgQWBBT1
D/Tge2xYx/QLkcuXAyMRyMldjjAfBgNVHSMEGDAWgBT1D/Tge2xYx/QLkcuXAyMR
yMldjjAPBgNVHRMBAf8EBTADAQH/MBgGA1UdEQQRMA+CDXJlZ2lzdHJ5LnRlc3Qw
CgYIKoZIzj0EAwIDRwAwRAIgJygPtP/eJSD5Et9o4vRwTHeNSNYPgwas4KAjuN7N
M4ICIGtlXyX0Hh4DAbJCtdSOiNeOBGwhJ5ZY8n2rxUEP54KO
-----END CERTIFICATE-----`;
const REGISTRY_TEST_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgzW7UAtKgkGx3t7Pj
C2EZdZ7oyyJCcbRHd2YMu+VteBKhRANCAASBm4IDCR9nc3QSYa69/HZE+NkUGB9q
NINRkShHyCQqlV2Jn8xEYBtjymhYpWw3QIR2Oj3A5nfk+EbtDT2RLFlU
-----END PRIVATE KEY-----`;

describe("registry artifact fetch", () => {
	afterEach(() => {
		setDefaultDnsResolver(null);
		setDefaultRegistryArtifactTransport(null);
	});

	it("connects to the exact public address returned by validation", async () => {
		setDefaultDnsResolver(async () => ["93.184.216.34", "2606:4700:4700::1111"]);
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
			allowedAddresses: ["93.184.216.34", "2606:4700:4700::1111"],
			maxResponseBytes: 1024,
		});
	});

	it("rejects a transport that connected outside the validated address set", async () => {
		setDefaultDnsResolver(async () => ["93.184.216.34"]);
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

	it.each([true, false])(
		"fetches over a Node TLS connection pinned to the approved address (autoSelectFamily: %s)",
		async (autoSelectFamily) => {
			const hosts: (string | undefined)[] = [];
			const server = createServer(
				{ cert: REGISTRY_TEST_CERT, key: REGISTRY_TEST_KEY },
				(req, res) => {
					hosts.push(req.headers.host);
					res.writeHead(200, { "Content-Type": "application/gzip", "Content-Length": "8" });
					res.end("artifact");
				},
			);
			server.listen(0, "127.0.0.1");
			await once(server, "listening");
			const { port } = server.address() as AddressInfo;
			const previousAutoSelectFamily = getDefaultAutoSelectFamily();
			setDefaultAutoSelectFamily(autoSelectFamily);

			try {
				const transport = await createNodeRegistryArtifactTransport((options, callback) =>
					request({ ...options, ca: REGISTRY_TEST_CERT }, callback),
				);
				const result = await transport.fetch({
					url: new URL(`https://registry.test:${port}/artifact.tgz`),
					allowedAddresses: ["127.0.0.1"],
					signal: new AbortController().signal,
					maxResponseBytes: 1024,
				});

				expect(result.connectedAddress).toBe("127.0.0.1");
				expect(await result.response.text()).toBe("artifact");
				expect(hosts).toEqual([`registry.test:${port}`]);
			} finally {
				setDefaultAutoSelectFamily(previousAutoSelectFamily);
				server.close();
			}
		},
	);
});
