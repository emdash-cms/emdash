export const PLUGIN_HTTP_MAX_REQUEST_BYTES = 8 * 1024 * 1024;
export const PLUGIN_HTTP_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const REDIRECT_BODY_HEADERS = [
	"content-encoding",
	"content-language",
	"content-location",
	"content-type",
	"content-length",
	"transfer-encoding",
];
const PLUGIN_HTTP_REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

export type PluginHttpRedirectAction = "return" | "follow" | "error";

export interface PluginHttpResponseWire {
	status: number;
	statusText: string;
	headers: Array<[string, string]>;
	finalUrl: string;
	redirected: boolean;
	body: Uint8Array;
}

export async function readPluginHttpBytes(
	stream: ReadableStream<Uint8Array> | null,
	limit: number,
	label: "request" | "response",
): Promise<Uint8Array> {
	if (!stream) return new Uint8Array();
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			total += value.byteLength;
			if (total > limit) {
				try {
					await reader.cancel();
				} catch {
					// The byte limit remains the caller-visible failure.
				}
				throw new Error(`Plugin HTTP ${label} body exceeds the ${limit} byte limit`);
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}

	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

export async function bufferPluginHttpRequest(
	init: RequestInit | undefined,
): Promise<RequestInit | undefined> {
	if (!init?.body) return init;
	const encoded = new Response(init.body);
	const body = await readPluginHttpBytes(encoded.body, PLUGIN_HTTP_MAX_REQUEST_BYTES, "request");
	const headers = new Headers(init.headers);
	if (!headers.has("content-type")) {
		const contentType = encoded.headers.get("content-type");
		if (contentType) headers.set("content-type", contentType);
	}
	return { ...init, headers, body: new Uint8Array(body).buffer };
}

export function rewritePluginHttpRedirect(
	status: number,
	init: RequestInit | undefined,
): RequestInit | undefined {
	if (!init) return init;
	const method = (init.method ?? "GET").toUpperCase();
	const rewriteToGet =
		((status === 301 || status === 302) && method === "POST") ||
		(status === 303 && method !== "GET" && method !== "HEAD");
	if (!rewriteToGet) return init;

	const headers = new Headers(init.headers);
	for (const name of REDIRECT_BODY_HEADERS) headers.delete(name);
	return { ...init, method: "GET", headers, body: undefined };
}

export function pluginHttpRedirectAction(
	status: number,
	hasLocation: boolean,
	init: RequestInit | undefined,
): PluginHttpRedirectAction {
	if (!PLUGIN_HTTP_REDIRECT_STATUSES.has(status) || !hasLocation) return "return";
	const mode = init?.redirect ?? "follow";
	if (mode === "manual") return "return";
	if (mode === "error") return "error";
	return "follow";
}

export async function pluginHttpResponseToWire(
	response: Response,
	finalUrl: string,
	redirected: boolean,
): Promise<PluginHttpResponseWire> {
	const headers: Array<[string, string]> = [];
	response.headers.forEach((value, key) => headers.push([key, value]));
	return {
		status: response.status,
		statusText: response.statusText,
		headers,
		finalUrl: response.url || finalUrl,
		redirected: response.redirected || redirected,
		body: await readPluginHttpBytes(response.body, PLUGIN_HTTP_MAX_RESPONSE_BYTES, "response"),
	};
}

function decoratePluginHttpResponse(
	response: Response,
	finalUrl: string,
	redirected: boolean,
): Response {
	const clone = response.clone.bind(response);
	Object.defineProperties(response, {
		url: { configurable: true, value: finalUrl },
		redirected: { configurable: true, value: redirected },
		clone: {
			configurable: true,
			value: () => decoratePluginHttpResponse(clone(), finalUrl, redirected),
		},
	});
	return response;
}

export function pluginHttpResponseFromWire(wire: PluginHttpResponseWire): Response {
	const nullBodyStatus =
		wire.status === 101 || wire.status === 204 || wire.status === 205 || wire.status === 304;
	const response = new Response(nullBodyStatus ? null : new Uint8Array(wire.body).buffer, {
		status: wire.status,
		statusText: wire.statusText,
		headers: wire.headers,
	});
	return decoratePluginHttpResponse(response, wire.finalUrl, wire.redirected);
}
