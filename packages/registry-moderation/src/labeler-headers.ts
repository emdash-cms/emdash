import { DID } from "./did.js";
import type { AcceptedLabelerPolicy } from "./index.js";

/** Indicates that an `atproto-accept-labelers` header value has invalid RFC 8941 syntax. */
export class InvalidAcceptLabelersHeaderError extends TypeError {
	constructor(message: string) {
		super(message);
		this.name = "InvalidAcceptLabelersHeaderError";
	}
}

interface Cursor {
	value: string;
	index: number;
}

type BareItem =
	| { kind: "boolean"; value: boolean }
	| { kind: "token"; value: string }
	| { kind: "string"; value: string };

// RFC 8941 §3.3.4 sf-token, extended with ":" and "/" as the grammar requires.
const TOKEN_CHAR = /^[A-Za-z*][!#$%&'*+\-.^_`|~0-9A-Za-z:/]*/;
// RFC 8941 §3.1.2 key: (lcalpha / "*") *(lcalpha / DIGIT / "_" / "-" / "." / "*").
const PARAM_KEY = /^[a-z*][a-z0-9_.\-*]*/;
const LEADING_OWS = /^[ \t]*/;
const BLANK_HEADER_VALUE = /^[ \t]*$/;

function remaining(cursor: Cursor): string {
	return cursor.value.slice(cursor.index);
}

function atEnd(cursor: Cursor): boolean {
	return cursor.index >= cursor.value.length;
}

// RFC 9110 §5.6.3 OWS = *( SP / HTAB ), used between sf-list members.
function consumeOws(cursor: Cursor): void {
	const match = LEADING_OWS.exec(remaining(cursor))!;
	cursor.index += match[0].length;
}

// RFC 8941 §4.2.3.2 only allows *SP (no HTAB) directly after ";".
function consumeSpaces(cursor: Cursor): void {
	while (cursor.value[cursor.index] === " ") cursor.index += 1;
}

function parseDidToken(cursor: Cursor): string {
	const match = TOKEN_CHAR.exec(remaining(cursor));
	if (!match) throw new InvalidAcceptLabelersHeaderError("expected a labeler DID");
	const token = match[0];
	cursor.index += token.length;
	if (!DID.test(token)) throw new InvalidAcceptLabelersHeaderError(`invalid labeler DID: ${token}`);
	return token;
}

function parseQuotedString(cursor: Cursor): string {
	cursor.index += 1; // opening DQUOTE
	let result = "";
	for (;;) {
		if (atEnd(cursor))
			throw new InvalidAcceptLabelersHeaderError("unterminated quoted string in parameter value");
		const char = cursor.value[cursor.index]!;
		if (char === '"') {
			cursor.index += 1;
			return result;
		}
		if (char === "\\") {
			const escaped = cursor.value[cursor.index + 1];
			if (escaped !== '"' && escaped !== "\\")
				throw new InvalidAcceptLabelersHeaderError(
					"invalid escape sequence in quoted string parameter value",
				);
			result += escaped;
			cursor.index += 2;
			continue;
		}
		const code = char.charCodeAt(0);
		if (code < 0x20 || code === 0x7f)
			throw new InvalidAcceptLabelersHeaderError(
				"invalid character in quoted string parameter value",
			);
		result += char;
		cursor.index += 1;
	}
}

function parseBareItem(cursor: Cursor): BareItem {
	const rest = remaining(cursor);
	if (rest.startsWith("?")) {
		const flag = rest[1];
		if (flag !== "0" && flag !== "1")
			throw new InvalidAcceptLabelersHeaderError("invalid boolean parameter value");
		cursor.index += 2;
		return { kind: "boolean", value: flag === "1" };
	}
	if (rest.startsWith('"')) return { kind: "string", value: parseQuotedString(cursor) };
	const tokenMatch = TOKEN_CHAR.exec(rest);
	if (tokenMatch) {
		cursor.index += tokenMatch[0].length;
		return { kind: "token", value: tokenMatch[0] };
	}
	throw new InvalidAcceptLabelersHeaderError("invalid parameter value");
}

function parseParameters(cursor: Cursor): Map<string, BareItem> {
	const params = new Map<string, BareItem>();
	while (remaining(cursor).startsWith(";")) {
		cursor.index += 1;
		consumeSpaces(cursor);
		const keyMatch = PARAM_KEY.exec(remaining(cursor));
		if (!keyMatch) throw new InvalidAcceptLabelersHeaderError("expected a parameter key after ';'");
		const key = keyMatch[0];
		cursor.index += key.length;
		let paramValue: BareItem = { kind: "boolean", value: true };
		if (remaining(cursor).startsWith("=")) {
			cursor.index += 1;
			paramValue = parseBareItem(cursor);
		}
		params.set(key, paramValue);
	}
	return params;
}

/**
 * Parses an `atproto-accept-labelers` header VALUE. The caller resolves the
 * missing-header case to deployment defaults before calling; an empty or
 * whitespace-only value means "no accepted labelers" and returns [].
 */
export function parseAcceptLabelersHeader(value: string): AcceptedLabelerPolicy[] {
	if (BLANK_HEADER_VALUE.test(value)) return [];

	const cursor: Cursor = { value, index: 0 };
	consumeOws(cursor);

	const order: string[] = [];
	// Union merge: an explicit later `?0` never un-sets an earlier true, since
	// redact is a "does any accepted policy for this DID ask to redact" flag.
	const redactByDid = new Map<string, boolean>();

	for (;;) {
		const did = parseDidToken(cursor);
		const params = parseParameters(cursor);
		const redactParam = params.get("redact");
		let redact = false;
		if (redactParam !== undefined) {
			if (redactParam.kind !== "boolean")
				throw new InvalidAcceptLabelersHeaderError(
					`redact parameter for ${did} must be a boolean (?0 or ?1)`,
				);
			redact = redactParam.value;
		}
		const existing = redactByDid.get(did);
		if (existing === undefined) order.push(did);
		redactByDid.set(did, existing === true || redact);

		consumeOws(cursor);
		if (atEnd(cursor)) break;
		if (cursor.value[cursor.index] !== ",")
			throw new InvalidAcceptLabelersHeaderError(
				`unexpected character at position ${cursor.index} in atproto-accept-labelers header`,
			);
		cursor.index += 1;
		consumeOws(cursor);
		if (atEnd(cursor))
			throw new InvalidAcceptLabelersHeaderError(
				"trailing comma in atproto-accept-labelers header",
			);
	}

	return order.map((did) => ({ did, redact: redactByDid.get(did)! }));
}

/**
 * Serializes the sources actually considered into `atproto-content-labelers`
 * form. An empty policy list serializes to "" -- callers omit the header
 * entirely in that case rather than sending an empty header value.
 */
export function serializeContentLabelersHeader(policies: readonly AcceptedLabelerPolicy[]): string {
	const order: string[] = [];
	const redactByDid = new Map<string, boolean>();
	for (const policy of policies) {
		const existing = redactByDid.get(policy.did);
		if (existing === undefined) order.push(policy.did);
		redactByDid.set(policy.did, existing === true || policy.redact);
	}
	return order.map((did) => (redactByDid.get(did) ? `${did};redact` : did)).join(", ");
}
