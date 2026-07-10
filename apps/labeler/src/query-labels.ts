import { xrpcError } from "./xrpc.js";

const DID = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+(?:[:][A-Za-z0-9._:%-]+)*$/;
const DIGITS = /^\d+$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;

interface LabelRow {
	sequence: number;
	ver: number;
	src: string;
	uri: string;
	cid: string | null;
	val: string;
	neg: number;
	cts: string;
	exp: string | null;
	sig: ArrayBuffer;
}

export async function queryLabels(db: D1Database, request: Request): Promise<Response> {
	if (request.method !== "GET") {
		return xrpcError("MethodNotSupported", "queryLabels only supports GET", 405, { allow: "GET" });
	}
	const params = new URL(request.url).searchParams;
	const uriPatterns = params.getAll("uriPatterns");
	if (uriPatterns.length === 0) return badRequest("uriPatterns is required");
	const patterns = uriPatterns.map(parseUriPattern);
	if (patterns.some((pattern) => pattern === null)) return badRequest("invalid uriPatterns");
	const sources = params.getAll("sources");
	if (sources.some((source) => !DID.test(source))) return badRequest("sources must contain DIDs");
	const limit = parseLimit(params.get("limit"));
	if (limit === null) return badRequest("limit must be an integer between 1 and 250");
	const cursor = parseCursor(params.get("cursor"));
	if (cursor === null) return badRequest("cursor must be a positive integer");

	const patternClauses: string[] = [];
	const values: (string | number)[] = [];
	for (const pattern of patterns) {
		if (!pattern) continue;
		if (pattern.endsWith("*")) {
			patternClauses.push("substr(uri, 1, ?) = ?");
			const prefix = pattern.slice(0, -1);
			values.push(prefix.length, prefix);
		} else {
			patternClauses.push("uri = ?");
			values.push(pattern);
		}
	}
	const sourceClause =
		sources.length > 0 ? ` AND src IN (${sources.map(() => "?").join(", ")})` : "";
	values.push(...sources, cursor ?? 0, limit + 1);
	const rows = await db
		.prepare(
			`SELECT sequence, ver, src, uri, cid, val, neg, cts, exp, sig
			 FROM issued_labels
			 WHERE (${patternClauses.join(" OR ")})${sourceClause} AND sequence > ?
			 ORDER BY sequence ASC LIMIT ?`,
		)
		.bind(...values)
		.all<LabelRow>();
	const labels = rows.results ?? [];
	const page = labels.slice(0, limit);
	const last = page.at(-1);
	return Response.json({
		labels: page.map((label) => ({
			ver: label.ver,
			src: label.src,
			uri: label.uri,
			...(label.cid === null ? {} : { cid: label.cid }),
			val: label.val,
			...(label.neg === 1 ? { neg: true } : {}),
			cts: label.cts,
			...(label.exp === null ? {} : { exp: label.exp }),
			sig: { $bytes: toBase64(new Uint8Array(label.sig)) },
		})),
		...(labels.length > limit && last ? { cursor: `${last.sequence}` } : {}),
	});
}

function parseUriPattern(value: string): string | null {
	if (value.length === 0 || value.length > 2_000) return null;
	const firstStar = value.indexOf("*");
	if (firstStar !== -1 && firstStar !== value.length - 1) return null;
	return value;
}

function parseLimit(value: string | null): number | null {
	if (value === null) return DEFAULT_LIMIT;
	if (!DIGITS.test(value)) return null;
	const limit = Number(value);
	return Number.isSafeInteger(limit) && limit >= 1 && limit <= MAX_LIMIT ? limit : null;
}

function parseCursor(value: string | null): number | null {
	if (value === null) return 0;
	if (!POSITIVE_INTEGER.test(value)) return null;
	const cursor = Number(value);
	return Number.isSafeInteger(cursor) ? cursor : null;
}

function badRequest(message: string): Response {
	return xrpcError("InvalidRequest", message, 400);
}

function toBase64(value: Uint8Array): string {
	return btoa(String.fromCharCode(...value));
}
