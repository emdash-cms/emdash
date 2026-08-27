import { resolveAndValidateExternalUrlTarget, SsrfError } from "../security/ssrf.js";

const TRAILING_DOT = /\.+$/;
const HEADER_END = new Uint8Array([13, 10, 13, 10]);
const CRLF = new Uint8Array([13, 10]);
const STATUS_LINE_RE = /^HTTP\/1\.[01] ([2-5][0-9]{2})(?: .*)?$/;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const FOLDED_HEADER_RE = /^[ \t]/;
const CONTENT_LENGTH_RE = /^(0|[1-9][0-9]*)$/;
const CHUNK_SIZE_RE = /^[0-9A-Fa-f]+$/;
const MAX_HEADER_BYTES = 32 * 1024;
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
		connectedAddress: string;
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
	if (!target.addresses.includes(result.connectedAddress)) {
		await result.response.body?.cancel().catch(() => undefined);
		throw new Error("Registry artifact transport connected outside the validated address set");
	}
	return result.response;
}

async function createRuntimeRegistryArtifactTransport(): Promise<RegistryArtifactTransport> {
	try {
		// @ts-ignore - virtual module
		const sockets: unknown = await import("cloudflare:sockets");
		const connect = objectProperty(sockets, "connect");
		if (!isWorkerSocketConnect(connect)) throw new TypeError("Workers socket binding is invalid");
		return createWorkersRegistryArtifactTransport(connect);
	} catch {
		return createNodeRegistryArtifactTransport();
	}
}

export interface RegistryArtifactWorkerSocket {
	readonly opened: Promise<unknown>;
	readonly readable: ReadableStream<Uint8Array>;
	readonly writable: WritableStream<Uint8Array>;
	startTls(options: { expectedServerHostname: string }): RegistryArtifactWorkerSocket;
	close(): Promise<void>;
}

export type RegistryArtifactWorkerSocketConnect = (
	address: { hostname: string; port: number },
	options: { secureTransport: "starttls"; allowHalfOpen: false },
) => RegistryArtifactWorkerSocket;

export function createWorkersRegistryArtifactTransport(
	connect: RegistryArtifactWorkerSocketConnect,
): RegistryArtifactTransport {
	return {
		async fetch(input) {
			let lastError: unknown;
			for (const address of input.allowedAddresses) {
				if (input.signal.aborted) throw new Error("Registry artifact request was aborted");
				let socket: RegistryArtifactWorkerSocket | undefined;
				let tls: RegistryArtifactWorkerSocket | undefined;
				try {
					socket = connect(
						{ hostname: address, port: parseHttpsPort(input.url) },
						{ secureTransport: "starttls", allowHalfOpen: false },
					);
					await abortable(socket.opened, input.signal, () => socket?.close());
					tls = socket.startTls({
						expectedServerHostname: stripIpv6Brackets(input.url.hostname),
					});
					await abortable(tls.opened, input.signal, () => tls?.close());
					const writer = tls.writable.getWriter();
					try {
						await abortable(writer.write(buildHttpRequest(input.url)), input.signal, () =>
							tls?.close(),
						);
					} finally {
						writer.releaseLock();
					}
					const bytes = await readWorkerSocketResponse(
						tls,
						input.maxResponseBytes + MAX_HEADER_BYTES,
						input.signal,
					);
					await tls.close().catch(() => undefined);
					return {
						response: parsedResponseToWebResponse(
							parsePinnedHttpResponse(bytes, input.maxResponseBytes),
						),
						connectedAddress: address,
					};
				} catch (error) {
					await Promise.all([
						tls?.close().catch(() => undefined),
						socket?.close().catch(() => undefined),
					]);
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

async function createNodeRegistryArtifactTransport(): Promise<RegistryArtifactTransport> {
	const { request } = await import("node:https");
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
								lookup: (_hostname, _options, callback) => {
									callback(null, address, address.includes(":") ? 6 : 4);
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

function parsePinnedHttpResponse(bytes: Uint8Array, maxResponseBytes: number): ParsedHttpResponse {
	const headerEnd = findSequence(bytes, HEADER_END, 0);
	if (headerEnd === -1 || headerEnd > MAX_HEADER_BYTES) {
		throw new Error("Registry artifact response headers are invalid or too large");
	}
	const headerText = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, headerEnd));
	const lines = headerText.split("\r\n");
	const statusMatch = STATUS_LINE_RE.exec(lines.shift() ?? "");
	if (!statusMatch) throw new Error("Registry artifact response status line is invalid");
	const headers = new Headers();
	const rawHeaders = new Map<string, string[]>();
	for (const line of lines) {
		if (FOLDED_HEADER_RE.test(line)) {
			throw new Error("Registry artifact response uses folded headers");
		}
		const separator = line.indexOf(":");
		if (separator < 1) throw new Error("Registry artifact response header is invalid");
		const name = line.slice(0, separator);
		const value = line.slice(separator + 1).trim();
		if (!HEADER_NAME_RE.test(name) || containsInvalidHeaderValue(value)) {
			throw new Error("Registry artifact response header is invalid");
		}
		const normalized = name.toLowerCase();
		const values = rawHeaders.get(normalized) ?? [];
		values.push(value);
		rawHeaders.set(normalized, values);
		headers.append(name, value);
	}
	const contentEncoding = rawHeaders.get("content-encoding");
	if (
		contentEncoding &&
		(contentEncoding.length !== 1 || contentEncoding[0]?.toLowerCase() !== "identity")
	) {
		throw new Error("Registry artifact response content encoding is unsupported");
	}
	const contentLength = rawHeaders.get("content-length");
	const transferEncoding = rawHeaders.get("transfer-encoding");
	if (contentLength && transferEncoding) {
		throw new Error("Registry artifact response framing is ambiguous");
	}
	const bodyBytes = bytes.subarray(headerEnd + HEADER_END.length);
	let body: Uint8Array;
	if (transferEncoding) {
		if (transferEncoding.length !== 1 || transferEncoding[0]?.toLowerCase() !== "chunked") {
			throw new Error("Registry artifact response transfer encoding is unsupported");
		}
		body = decodeChunkedBody(bodyBytes, maxResponseBytes);
	} else if (contentLength) {
		if (contentLength.length !== 1 || !CONTENT_LENGTH_RE.test(contentLength[0])) {
			throw new Error("Registry artifact response content length is invalid");
		}
		const length = Number(contentLength[0]);
		if (!Number.isSafeInteger(length) || length !== bodyBytes.byteLength) {
			throw new Error("Registry artifact response body length does not match its framing");
		}
		body = new Uint8Array(bodyBytes);
	} else {
		body = new Uint8Array(bodyBytes);
	}
	if (body.byteLength > maxResponseBytes) {
		throw new RangeError("Registry artifact response exceeds its byte limit");
	}
	return { status: Number(statusMatch[1]), headers, body };
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

function buildHttpRequest(url: URL): Uint8Array {
	return new TextEncoder().encode(
		[
			`GET ${url.pathname}${url.search} HTTP/1.1`,
			`Host: ${url.host}`,
			"Connection: close",
			"Accept-Encoding: identity",
			"",
			"",
		].join("\r\n"),
	);
}

async function readWorkerSocketResponse(
	socket: RegistryArtifactWorkerSocket,
	maximumBytes: number,
	signal: AbortSignal,
): Promise<Uint8Array> {
	const reader = socket.readable.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		for (;;) {
			const next = await abortable(reader.read(), signal, () => socket.close());
			if (next.done) break;
			total += next.value.byteLength;
			if (total > maximumBytes) {
				throw new RangeError("Registry artifact response exceeds its byte limit");
			}
			chunks.push(next.value);
		}
	} finally {
		reader.releaseLock();
	}
	return concatBytes(chunks, total);
}

function decodeChunkedBody(bytes: Uint8Array, maximumBytes: number): Uint8Array {
	const chunks: Uint8Array[] = [];
	let offset = 0;
	let total = 0;
	for (;;) {
		const lineEnd = findSequence(bytes, CRLF, offset);
		if (lineEnd === -1 || lineEnd - offset > 128) {
			throw new Error("Registry artifact chunk size line is invalid");
		}
		const sizeText = new TextDecoder().decode(bytes.subarray(offset, lineEnd)).split(";", 1)[0];
		if (!sizeText || !CHUNK_SIZE_RE.test(sizeText)) {
			throw new Error("Registry artifact chunk size is invalid");
		}
		const size = Number.parseInt(sizeText, 16);
		if (!Number.isSafeInteger(size)) throw new Error("Registry artifact chunk size is invalid");
		offset = lineEnd + CRLF.length;
		if (size === 0) {
			if (
				offset + CRLF.length !== bytes.length ||
				bytes[offset] !== 13 ||
				bytes[offset + 1] !== 10
			) {
				throw new Error("Registry artifact chunk trailer is invalid");
			}
			break;
		}
		if (offset + size + CRLF.length > bytes.length) {
			throw new Error("Registry artifact chunk body is truncated");
		}
		if (bytes[offset + size] !== 13 || bytes[offset + size + 1] !== 10) {
			throw new Error("Registry artifact chunk delimiter is invalid");
		}
		total += size;
		if (total > maximumBytes) {
			throw new RangeError("Registry artifact response exceeds its byte limit");
		}
		chunks.push(new Uint8Array(bytes.subarray(offset, offset + size)));
		offset += size + CRLF.length;
	}
	return concatBytes(chunks, total);
}

function findSequence(bytes: Uint8Array, sequence: Uint8Array, start: number): number {
	outer: for (let offset = start; offset <= bytes.length - sequence.length; offset += 1) {
		for (let index = 0; index < sequence.length; index += 1) {
			if (bytes[offset + index] !== sequence[index]) continue outer;
		}
		return offset;
	}
	return -1;
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

function containsInvalidHeaderValue(value: string): boolean {
	for (const character of value) {
		const code = character.codePointAt(0)!;
		if (code === 0 || code === 10 || code === 13) return true;
	}
	return false;
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

function objectProperty(value: unknown, key: string): unknown {
	if (typeof value !== "object" || value === null) return undefined;
	return Object.getOwnPropertyDescriptor(value, key)?.value;
}

function isWorkerSocketConnect(value: unknown): value is RegistryArtifactWorkerSocketConnect {
	return typeof value === "function";
}

async function abortable<T>(
	operation: Promise<T>,
	signal: AbortSignal,
	onAbort: () => void | Promise<void>,
): Promise<T> {
	if (signal.aborted) throw new Error("Registry artifact request was aborted");
	let abort: (() => void) | undefined;
	const aborted = new Promise<never>((_resolve, reject) => {
		abort = () => {
			void onAbort();
			reject(new Error("Registry artifact request was aborted"));
		};
		signal.addEventListener("abort", abort, { once: true });
	});
	try {
		return await Promise.race([operation, aborted]);
	} finally {
		if (abort) signal.removeEventListener("abort", abort);
	}
}
