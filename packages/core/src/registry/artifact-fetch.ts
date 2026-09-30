import type { ClientRequest, IncomingMessage } from "node:http";
import type { RequestOptions } from "node:https";

import { resolveAndValidateExternalUrlTarget, SsrfError } from "../security/ssrf.js";

const TRAILING_DOT = /\.+$/;
const LOCALHOST_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"ip6-localhost",
	"ip6-loopback",
]);

export interface RegistryArtifactTransportInput {
	url: URL;
	allowedAddresses: readonly string[];
	signal: AbortSignal;
	maxResponseBytes: number;
}

export interface RegistryArtifactTransport {
	fetch(input: RegistryArtifactTransportInput): Promise<{
		response: Response;
		/** Workers Fetch does not expose its connected peer; DNS validation still runs before dispatch. */
		connectedAddress: string | null;
	}>;
}

export interface RegistryArtifactFetchOptions {
	signal: AbortSignal;
	maxResponseBytes: number;
}

let defaultTransport: RegistryArtifactTransport | null = null;

export function setDefaultRegistryArtifactTransport(
	transport: RegistryArtifactTransport | null,
): RegistryArtifactTransport | null {
	const previous = defaultTransport;
	defaultTransport = transport;
	return previous;
}

function isLocalhostHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase().replace(TRAILING_DOT, "");
	return (
		LOCALHOST_HOSTNAMES.has(normalized) ||
		normalized.endsWith(".localhost") ||
		normalized === "127.0.0.1" ||
		normalized === "::1" ||
		normalized === "[::1]" ||
		normalized.startsWith("::ffff:127.") ||
		normalized.startsWith("::ffff:7f00:")
	);
}

async function resolveSafeArtifactTarget(urlString: string): Promise<{
	url: URL;
	addresses: readonly string[];
}> {
	let url: URL;
	try {
		url = new URL(urlString);
	} catch {
		throw new Error(`Invalid artifact URL: ${urlString}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`Artifact URL protocol not allowed: ${url.protocol}`);
	}
	if (url.username || url.password) {
		throw new Error("Artifact URL must not contain embedded credentials");
	}

	const rawHostname = url.hostname.toLowerCase().replace(TRAILING_DOT, "");
	const hostname = stripIpv6Brackets(rawHostname);
	const localhost = isLocalhostHostname(hostname);

	if (!import.meta.env.DEV) {
		if (url.protocol === "http:") {
			throw new Error("Artifact URL must use https");
		}
		if (localhost) {
			throw new Error(`Artifact URL points to localhost: ${hostname}`);
		}
	} else if (url.protocol === "http:" && !localhost) {
		throw new Error("Artifact URL must use https (http allowed only for localhost in dev)");
	}

	if (localhost) {
		return { url, addresses: [] };
	}

	try {
		return await resolveAndValidateExternalUrlTarget(url.href);
	} catch (error) {
		if (error instanceof SsrfError) {
			throw new Error(`Artifact URL rejected: ${error.message}`, { cause: error });
		}
		throw error;
	}
}

export async function assertSafeArtifactUrl(urlString: string): Promise<URL> {
	return (await resolveSafeArtifactTarget(urlString)).url;
}

export async function fetchRegistryArtifactUrl(
	urlString: string,
	options: RegistryArtifactFetchOptions,
): Promise<Response> {
	if (!Number.isSafeInteger(options.maxResponseBytes) || options.maxResponseBytes < 0) {
		throw new TypeError("Registry artifact response limit is invalid");
	}
	const target = await resolveSafeArtifactTarget(urlString);
	if (target.addresses.length === 0) {
		return globalThis.fetch(target.url, { redirect: "manual", signal: options.signal });
	}

	const transport = defaultTransport ?? (await createRuntimeRegistryArtifactTransport());
	const result = await transport.fetch({
		url: target.url,
		allowedAddresses: target.addresses,
		signal: options.signal,
		maxResponseBytes: options.maxResponseBytes,
	});
	if (result.connectedAddress !== null && !target.addresses.includes(result.connectedAddress)) {
		await result.response.body?.cancel().catch(() => undefined);
		throw new Error("Registry artifact transport connected outside the validated address set");
	}
	return result.response;
}

async function createRuntimeRegistryArtifactTransport(): Promise<RegistryArtifactTransport> {
	return isCloudflareWorkersRuntime()
		? createWorkersRegistryArtifactTransport()
		: createNodeRegistryArtifactTransport();
}

export function createWorkersRegistryArtifactTransport(
	workerFetch: typeof globalThis.fetch = globalThis.fetch,
): RegistryArtifactTransport {
	return {
		async fetch(input) {
			const response = await workerFetch(input.url, {
				redirect: "manual",
				signal: input.signal,
				headers: { "Accept-Encoding": "identity" },
			});
			return {
				response: limitResponseBody(response, input.maxResponseBytes),
				connectedAddress: null,
			};
		},
	};
}

function isCloudflareWorkersRuntime(): boolean {
	return (
		typeof navigator !== "undefined" &&
		typeof navigator.userAgent === "string" &&
		navigator.userAgent.includes("Cloudflare-Workers")
	);
}

function limitResponseBody(response: Response, maxBytes: number): Response {
	if (!response.body) return response;
	let received = 0;
	const body = response.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				received += chunk.byteLength;
				if (received > maxBytes) {
					controller.error(new RangeError("Registry artifact response exceeds its byte limit"));
					return;
				}
				controller.enqueue(chunk);
			},
		}),
	);
	return new Response(body, {
		status: response.status,
		statusText: response.statusText,
		headers: response.headers,
	});
}

export type RegistryArtifactNodeRequest = (
	options: RequestOptions,
	callback: (response: IncomingMessage) => void,
) => ClientRequest;

export async function createNodeRegistryArtifactTransport(
	nodeRequest?: RegistryArtifactNodeRequest,
): Promise<RegistryArtifactTransport> {
	const request = nodeRequest ?? (await import("node:https")).request;
	return {
		async fetch(input) {
			let lastError: unknown;
			for (const address of input.allowedAddresses) {
				try {
					const response = await new Promise<Response>((resolve, reject) => {
						const chunks: Uint8Array[] = [];
						let total = 0;
						const req = request(
							{
								protocol: "https:",
								hostname: stripIpv6Brackets(input.url.hostname),
								port: parseHttpsPort(input.url),
								path: `${input.url.pathname}${input.url.search}`,
								method: "GET",
								// A pooled socket may have been opened for the same hostname
								// before this address set was resolved.
								agent: false,
								headers: {
									Host: input.url.host,
									Connection: "close",
									"Accept-Encoding": "identity",
								},
								lookup: (_hostname, options, callback) => {
									const family = address.includes(":") ? 6 : 4;
									// Node's default autoSelectFamily asks with `all: true` and expects a list.
									if (options.all) callback(null, [{ address, family }]);
									else callback(null, address, family);
								},
								signal: input.signal,
							},
							(upstream) => {
								const contentEncoding = upstream.headers["content-encoding"];
								if (contentEncoding && contentEncoding.toLowerCase() !== "identity") {
									upstream.destroy(
										new Error("Registry artifact response content encoding is unsupported"),
									);
									return;
								}
								upstream.on("data", (chunk: Uint8Array) => {
									total += chunk.byteLength;
									if (total > input.maxResponseBytes) {
										upstream.destroy(
											new RangeError("Registry artifact response exceeds its byte limit"),
										);
										return;
									}
									chunks.push(new Uint8Array(chunk));
								});
								upstream.once("error", reject);
								upstream.once("end", () => {
									const bytes = concatBytes(chunks, total);
									const headers = new Headers();
									for (let index = 0; index < upstream.rawHeaders.length; index += 2) {
										headers.append(upstream.rawHeaders[index], upstream.rawHeaders[index + 1]);
									}
									resolve(
										parsedResponseToWebResponse({
											status: upstream.statusCode ?? 502,
											headers,
											body: bytes,
										}),
									);
								});
							},
						);
						req.once("error", reject);
						req.end();
					});
					return { response, connectedAddress: address };
				} catch (error) {
					if (input.signal.aborted) throw error;
					lastError = error;
				}
			}
			throw new Error("Registry artifact transport could not connect to an approved address", {
				cause: lastError,
			});
		},
	};
}

interface ParsedHttpResponse {
	status: number;
	headers: Headers;
	body: Uint8Array;
}

function parsedResponseToWebResponse(parsed: ParsedHttpResponse): Response {
	const bodyAllowed = ![204, 205, 304].includes(parsed.status);
	let body: ArrayBuffer | null = null;
	if (bodyAllowed) {
		body = new ArrayBuffer(parsed.body.byteLength);
		new Uint8Array(body).set(parsed.body);
	}
	return new Response(body, {
		status: parsed.status,
		headers: parsed.headers,
	});
}

function concatBytes(chunks: readonly Uint8Array[], total: number): Uint8Array {
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

function parseHttpsPort(url: URL): number {
	const port = url.port === "" ? 443 : Number(url.port);
	if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
		throw new TypeError("Registry artifact HTTPS port is invalid");
	}
	return port;
}

function stripIpv6Brackets(hostname: string): string {
	return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}
