interface QueryLabelRow {
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

const DID =
	/^did:[a-z0-9]+:(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+(?::(?:[A-Za-z0-9._-]|%[0-9A-Fa-f]{2})+)*$/;
const NON_NEGATIVE_INTEGER = /^(?:0|[1-9]\d*)$/;
const POSITIVE_INTEGER = /^[1-9]\d*$/;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 250;
const MAX_URI_PATTERNS = 25;
const MAX_SOURCES = 20;

export async function queryLabels(
	db: D1Database,
	request: Request,
	createSigner?: () => Promise<ListingLabelSigner>,
): Promise<Response> {
	if (request.method !== "GET") {
		return xrpcError("MethodNotSupported", "queryLabels only supports GET", 405, {
			allow: "GET",
		});
	}
	const params = new URL(request.url).searchParams;
	const rawPatterns = params.getAll("uriPatterns");
	if (rawPatterns.length === 0 || rawPatterns.length > MAX_URI_PATTERNS) {
		return invalidRequest(`uriPatterns must contain between 1 and ${MAX_URI_PATTERNS} values`);
	}
	const patterns = rawPatterns.map(parseUriPattern);
	if (patterns.some((pattern) => pattern === null)) {
		return invalidRequest("uriPatterns contains an invalid pattern");
	}
	const sources = params.getAll("sources");
	if (sources.length > MAX_SOURCES || sources.some((source) => !DID.test(source))) {
		return invalidRequest(`sources must contain at most ${MAX_SOURCES} DIDs`);
	}
	const limit = parseLimit(params.get("limit"));
	if (limit === null) {
		return invalidRequest(`limit must be an integer between 1 and ${MAX_LIMIT}`);
	}
	const cursor = parseCursor(params.get("cursor"));
	if (cursor === null) return invalidRequest("cursor must be a non-negative integer");

	const patternClauses: string[] = [];
	const values: unknown[] = [];
	for (const pattern of patterns) {
		if (pattern === null) continue;
		if (pattern.endsWith("*")) {
			const prefix = pattern.slice(0, -1);
			patternClauses.push("substr(uri, 1, ?) = ?");
			values.push(prefix.length, prefix);
		} else {
			patternClauses.push("uri = ?");
			values.push(pattern);
		}
	}
	const sourceClause =
		sources.length === 0 ? "" : ` AND src IN (${sources.map(() => "?").join(", ")})`;
	values.push(...sources, cursor, limit + 1);
	const result = await db
		.prepare(
			`SELECT sequence, ver, src, uri, cid, val, neg, cts, exp, sig
			 FROM issued_labels
			 WHERE (${patternClauses.join(" OR ")})${sourceClause} AND sequence > ?
			 ORDER BY sequence ASC
			 LIMIT ?`,
		)
		.bind(...values)
		.all<QueryLabelRow>();
	const rows = result.results ?? [];
	const page = rows.slice(0, limit);
	const last = page.at(-1);
	const signer = createSigner ? await createSigner() : undefined;
	return jsonResponse({
		labels: await Promise.all(page.map((row) => jsonLabel(row, signer))),
		...(rows.length > limit && last ? { cursor: `${last.sequence}` } : {}),
	});
}

function parseUriPattern(value: string): string | null {
	if (value.length === 0 || value.length > 2_000) return null;
	const star = value.indexOf("*");
	return star === -1 || star === value.length - 1 ? value : null;
}

function parseLimit(value: string | null): number | null {
	if (value === null) return DEFAULT_LIMIT;
	if (!POSITIVE_INTEGER.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) && parsed <= MAX_LIMIT ? parsed : null;
}

function parseCursor(value: string | null): number | null {
	if (value === null) return 0;
	if (!NON_NEGATIVE_INTEGER.test(value)) return null;
	const parsed = Number(value);
	return Number.isSafeInteger(parsed) ? parsed : null;
}

async function jsonLabel(
	row: QueryLabelRow,
	signer?: ListingLabelSigner,
): Promise<Record<string, unknown>> {
	const signed =
		signer && signer.issuerDid === row.src
			? await signer.sign({
					ver: 1,
					uri: row.uri,
					...(row.cid === null ? {} : { cid: row.cid }),
					val: row.val,
					...(row.neg === 1 ? { neg: true } : {}),
					cts: row.cts,
					...(row.exp === null ? {} : { exp: row.exp }),
				})
			: null;
	return {
		ver: signed?.ver ?? row.ver,
		src: signed?.src ?? row.src,
		uri: row.uri,
		...(row.cid === null ? {} : { cid: row.cid }),
		val: row.val,
		...(row.neg === 1 ? { neg: true } : {}),
		cts: row.cts,
		...(row.exp === null ? {} : { exp: row.exp }),
		sig: { $bytes: toBase64(signed?.sig ?? new Uint8Array(row.sig)) },
	};
}

function invalidRequest(message: string): Response {
	return xrpcError("InvalidRequest", message, 400);
}

function xrpcError(
	error: string,
	message: string,
	status: number,
	headers: HeadersInit = {},
): Response {
	return jsonResponse({ error, message }, { status, headers });
}

function jsonResponse(value: unknown, init: ResponseInit = {}): Response {
	const headers = new Headers(init.headers);
	headers.set("cache-control", "no-store");
	headers.set("content-type", "application/json; charset=utf-8");
	return new Response(JSON.stringify(value), { ...init, headers });
}

function toBase64(value: Uint8Array): string {
	return btoa(String.fromCharCode(...value));
}
import type { ListingLabelSigner } from "@emdash-cms/registry-moderation";
