import {
	PLUGIN_ROUTE_DEFAULT_BODY_BYTES,
	PLUGIN_ROUTE_MAX_BODY_BYTES,
	PLUGIN_ROUTE_MAX_FILENAME_BYTES,
	PLUGIN_ROUTE_MAX_MULTIPART_PART_BYTES,
	PLUGIN_ROUTE_MAX_MULTIPART_PARTS,
	type PluginRouteRequest,
} from "@emdash-cms/plugin-types";

import type { PluginFormData, PluginResponse } from "../plugin-types.js";
import { readPluginHttpBytes } from "./http-wire.js";

const UTF8 = new TextEncoder();
const FILENAME_PATH_SEPARATOR_PATTERN = /[/\\]/;
const SCRIPT_MEDIA_TYPE_PATTERN = /(?:java|ecma)script/;
const ALLOWED_RESPONSE_HEADERS = new Set([
	"accept-ranges",
	"content-disposition",
	"content-encoding",
	"content-language",
	"content-range",
	"content-type",
	"etag",
	"last-modified",
	"retry-after",
]);
const ACTIVE_RESPONSE_TYPES = new Set([
	"application/ecmascript",
	"application/javascript",
	"application/wasm",
	"application/xhtml+xml",
	"application/xml",
	"image/svg+xml",
	"multipart/related",
	"multipart/x-mixed-replace",
	"text/css",
	"text/ecmascript",
	"text/html",
	"text/javascript",
	"text/jscript",
	"text/livescript",
	"text/xml",
]);

export interface PluginRouteResponseWire {
	status: number;
	headers: Array<[string, string]>;
	body: Uint8Array;
}

export interface PluginRouteResponseWireOptions {
	allowExternalLocation?: boolean;
	publicRequestUrl?: string;
}

export class PluginRouteRequestError extends Error {
	constructor(
		message: string,
		readonly status: 400 | 413 | 415,
	) {
		super(message);
		this.name = "PluginRouteRequestError";
	}
}

function parseQuery(request: Request): Record<string, string | string[]> {
	const input: Record<string, string | string[]> = {};
	const params = new URL(request.url).searchParams;
	for (const key of new Set(params.keys())) {
		const values = params.getAll(key);
		input[key] = values.length > 1 ? values : values[0];
	}
	return input;
}

async function readRouteBody(request: Request, limit: number): Promise<Uint8Array> {
	const declaredLength = request.headers.get("content-length");
	if (declaredLength !== null) {
		const parsed = Number(declaredLength);
		if (Number.isFinite(parsed) && parsed > limit) {
			throw new PluginRouteRequestError(`Plugin route request body exceeds ${limit} bytes`, 413);
		}
	}
	try {
		return await readPluginHttpBytes(request.body, limit, "request");
	} catch (error) {
		if (!(error instanceof Error) || !error.message.includes("exceeds")) {
			throw new PluginRouteRequestError("Plugin route request body could not be read", 400);
		}
		throw new PluginRouteRequestError(`Plugin route request body exceeds ${limit} bytes`, 413);
	}
}

function decodeText(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw new PluginRouteRequestError("Plugin route request body is not valid UTF-8", 400);
	}
}

async function parseFormData(request: Request, bytes: Uint8Array): Promise<PluginFormData> {
	const contentType = request.headers.get("content-type") ?? "";
	if (
		!contentType.toLowerCase().startsWith("multipart/form-data;") &&
		!contentType.toLowerCase().startsWith("application/x-www-form-urlencoded")
	) {
		throw new PluginRouteRequestError(
			"Plugin route form-data requests require multipart/form-data or application/x-www-form-urlencoded",
			415,
		);
	}

	let parsed: FormData;
	try {
		parsed = await new Request(request.url, {
			method: "POST",
			headers: { "content-type": contentType },
			body: new Uint8Array(bytes).buffer,
		}).formData();
	} catch {
		throw new PluginRouteRequestError("Plugin route form-data body is malformed", 400);
	}

	const entries: PluginFormData["entries"] = [];
	for (const [name, value] of parsed.entries()) {
		if (entries.length >= PLUGIN_ROUTE_MAX_MULTIPART_PARTS) {
			throw new PluginRouteRequestError(
				`Plugin route form-data exceeds ${PLUGIN_ROUTE_MAX_MULTIPART_PARTS} parts`,
				413,
			);
		}
		if (typeof value === "string") {
			if (UTF8.encode(value).byteLength > PLUGIN_ROUTE_MAX_MULTIPART_PART_BYTES) {
				throw new PluginRouteRequestError(
					`Plugin route form-data part exceeds ${PLUGIN_ROUTE_MAX_MULTIPART_PART_BYTES} bytes`,
					413,
				);
			}
			entries.push({ name, kind: "text", value });
			continue;
		}

		const filename = value.name;
		let hasControlCharacter = false;
		for (const character of filename) {
			const codePoint = character.codePointAt(0);
			if (codePoint !== undefined && (codePoint < 32 || codePoint === 127)) {
				hasControlCharacter = true;
				break;
			}
		}
		if (
			UTF8.encode(filename).byteLength > PLUGIN_ROUTE_MAX_FILENAME_BYTES ||
			hasControlCharacter ||
			FILENAME_PATH_SEPARATOR_PATTERN.test(filename)
		) {
			throw new PluginRouteRequestError("Plugin route form-data filename is invalid", 400);
		}
		if (value.size > PLUGIN_ROUTE_MAX_MULTIPART_PART_BYTES) {
			throw new PluginRouteRequestError(
				`Plugin route form-data part exceeds ${PLUGIN_ROUTE_MAX_MULTIPART_PART_BYTES} bytes`,
				413,
			);
		}
		entries.push({
			name,
			kind: "file",
			filename,
			contentType: value.type || "application/octet-stream",
			bytes: new Uint8Array(await value.arrayBuffer()),
		});
	}
	return { entries };
}

export async function parseDeclaredPluginRouteInput(
	request: Request,
	declaration: PluginRouteRequest,
): Promise<unknown> {
	if (declaration.body === "none") {
		await readRouteBody(request, 0);
		return parseQuery(request);
	}
	const limit = declaration.maxBytes ?? PLUGIN_ROUTE_DEFAULT_BODY_BYTES;
	const bytes = await readRouteBody(request, Math.min(limit, PLUGIN_ROUTE_MAX_BODY_BYTES));

	switch (declaration.body) {
		case "bytes":
			return bytes;
		case "text":
			return decodeText(bytes);
		case "json":
			try {
				return JSON.parse(decodeText(bytes));
			} catch (error) {
				if (error instanceof PluginRouteRequestError) throw error;
				throw new PluginRouteRequestError("Plugin route request body is not valid JSON", 400);
			}
		case "form-data":
			return parseFormData(request, bytes);
	}
}

export function isPluginResponse(value: unknown): value is PluginResponse {
	return (
		typeof value === "object" &&
		value !== null &&
		(value as { __emdashPluginResponse?: unknown }).__emdashPluginResponse === true
	);
}

export async function pluginRouteResponseToWire(
	value: unknown,
	options: PluginRouteResponseWireOptions = {},
): Promise<PluginRouteResponseWire> {
	if (!isPluginResponse(value)) {
		throw new TypeError("Raw plugin routes must return pluginResponse()");
	}
	if (!Number.isInteger(value.status) || value.status < 200 || value.status > 599) {
		throw new TypeError("Raw plugin route status must be an integer from 200 to 599");
	}
	if (!Array.isArray(value.headers)) {
		throw new TypeError("Raw plugin route headers are invalid");
	}

	const sourceHeaders = new Headers();
	for (const entry of value.headers) {
		if (
			!Array.isArray(entry) ||
			entry.length !== 2 ||
			typeof entry[0] !== "string" ||
			typeof entry[1] !== "string"
		) {
			throw new TypeError("Raw plugin route headers are invalid");
		}
		sourceHeaders.append(entry[0], entry[1]);
	}

	const headers = new Headers();
	sourceHeaders.forEach((headerValue, name) => {
		if (ALLOWED_RESPONSE_HEADERS.has(name)) {
			headers.set(name, headerValue);
			return;
		}
		if (name !== "location") return;
		if (options.allowExternalLocation) {
			headers.set(name, headerValue);
			return;
		}
		if (options.publicRequestUrl) {
			try {
				const requestUrl = new URL(options.publicRequestUrl);
				if (new URL(headerValue, requestUrl).origin === requestUrl.origin) {
					headers.set(name, headerValue);
					return;
				}
			} catch {}
		}
		throw new TypeError("Public raw plugin route redirects must stay on the site origin");
	});
	if (!headers.has("content-type")) headers.set("content-type", "application/octet-stream");
	const mediaType = (headers.get("content-type") ?? "application/octet-stream")
		.split(";", 1)[0]
		.trim()
		.toLowerCase();
	if (ACTIVE_RESPONSE_TYPES.has(mediaType) || SCRIPT_MEDIA_TYPE_PATTERN.test(mediaType)) {
		throw new TypeError(`Raw plugin route content type "${mediaType}" is not allowed`);
	}
	headers.set("x-content-type-options", "nosniff");
	headers.set("content-security-policy", "sandbox; default-src 'none'");
	headers.set("referrer-policy", "no-referrer");

	let body = new Uint8Array();
	if (value.body !== null) {
		if (value.body.kind === "text" && typeof value.body.value === "string") {
			body = UTF8.encode(value.body.value);
		} else if (value.body.kind === "bytes" && value.body.value instanceof Uint8Array) {
			body = new Uint8Array(value.body.value);
		} else {
			throw new TypeError("Raw plugin route body is invalid");
		}
	}
	if (body.byteLength > PLUGIN_ROUTE_MAX_BODY_BYTES) {
		throw new TypeError(
			`Raw plugin route response body exceeds ${PLUGIN_ROUTE_MAX_BODY_BYTES} bytes`,
		);
	}

	return {
		status: value.status,
		headers: [...headers.entries()],
		body,
	};
}

export function pluginRouteResponseFromWire(
	wire: PluginRouteResponseWire,
	method: string,
): Response {
	const nullBodyStatus = wire.status === 204 || wire.status === 205 || wire.status === 304;
	const body = method === "HEAD" || nullBodyStatus ? null : new Uint8Array(wire.body).buffer;
	return new Response(body, { status: wire.status, headers: wire.headers });
}
