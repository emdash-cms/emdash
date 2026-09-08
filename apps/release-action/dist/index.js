import { createRequire } from "node:module";
import { appendFile, readFile, readdir, realpath, stat } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { Buffer as Buffer$1 } from "node:buffer";
import { spawn } from "node:child_process";

//#region ../../node_modules/.pnpm/@atcute+lexicons@2.0.0/node_modules/@atcute/lexicons/dist/syntax/did.js
const DID_RE = /^did:([a-z]+):([a-zA-Z0-9._:%-]*[a-zA-Z0-9._-])$/;
const isDid = /* @__NO_SIDE_EFFECTS__ */ (input) => {
	return typeof input === "string" && input.length >= 7 && input.length <= 2048 && DID_RE.test(input);
};

//#endregion
//#region ../../node_modules/.pnpm/@atcute+lexicons@2.0.0/node_modules/@atcute/lexicons/dist/syntax/utils/ascii.js
const isAsciiAlpha = /* @__NO_SIDE_EFFECTS__ */ (c) => {
	return c >= 65 && c <= 90 || c >= 97 && c <= 122;
};
const isAsciiAlphaNum = /* @__NO_SIDE_EFFECTS__ */ (c) => {
	return /* @__PURE__ */ isAsciiAlpha(c) || c >= 48 && c <= 57;
};

//#endregion
//#region ../../node_modules/.pnpm/@atcute+lexicons@2.0.0/node_modules/@atcute/lexicons/dist/syntax/handle.js
const isValidLabel = (input, start, end) => {
	const len = end - start;
	if (len === 0 || len > 63) return false;
	if (!/* @__PURE__ */ isAsciiAlphaNum(input.charCodeAt(start))) return false;
	if (len > 1) {
		if (!/* @__PURE__ */ isAsciiAlphaNum(input.charCodeAt(end - 1))) return false;
		for (let j = start + 1; j < end - 1; j++) {
			const c = input.charCodeAt(j);
			if (!/* @__PURE__ */ isAsciiAlphaNum(c) && c !== 45) return false;
		}
	}
	return true;
};
const isHandle = /* @__NO_SIDE_EFFECTS__ */ (input) => {
	if (typeof input !== "string") return false;
	const len = input.length;
	if (len < 3 || len > 253) return false;
	let labelStart = 0;
	let labelCount = 0;
	let lastLabelStart = 0;
	for (let i = 0; i <= len; i++) if (i === len || input.charCodeAt(i) === 46) {
		if (!isValidLabel(input, labelStart, i)) return false;
		lastLabelStart = labelStart;
		labelStart = i + 1;
		labelCount++;
	}
	if (labelCount < 2) return false;
	return /* @__PURE__ */ isAsciiAlpha(input.charCodeAt(lastLabelStart));
};

//#endregion
//#region ../../node_modules/.pnpm/@atcute+lexicons@2.0.0/node_modules/@atcute/lexicons/dist/syntax/at-identifier.js
const isActorIdentifier = /* @__NO_SIDE_EFFECTS__ */ (input) => {
	return /* @__PURE__ */ isDid(input) || /* @__PURE__ */ isHandle(input);
};

//#endregion
//#region ../../node_modules/.pnpm/@atcute+lexicons@2.0.0/node_modules/@atcute/lexicons/dist/syntax/nsid.js
const isNsid = /* @__NO_SIDE_EFFECTS__ */ (input) => {
	if (typeof input !== "string") return false;
	const len = input.length;
	if (len < 5 || len > 317) return false;
	let lastDot = -1;
	for (let j = len - 1; j >= 0; j--) if (input.charCodeAt(j) === 46) {
		lastDot = j;
		break;
	}
	if (lastDot === -1) return false;
	let segStart = 0;
	let segIdx = 0;
	for (let i = 0; i <= lastDot; i++) if (i === lastDot || input.charCodeAt(i) === 46) {
		const segLen = i - segStart;
		if (segLen === 0 || segLen > 63) return false;
		const first = input.charCodeAt(segStart);
		if (segIdx === 0) {
			if (!/* @__PURE__ */ isAsciiAlpha(first)) return false;
		} else if (!/* @__PURE__ */ isAsciiAlphaNum(first)) return false;
		if (segLen > 1) {
			if (!/* @__PURE__ */ isAsciiAlphaNum(input.charCodeAt(i - 1))) return false;
			for (let j = segStart + 1; j < i - 1; j++) {
				const c = input.charCodeAt(j);
				if (!/* @__PURE__ */ isAsciiAlphaNum(c) && c !== 45) return false;
			}
		}
		segStart = i + 1;
		segIdx++;
	}
	if (segIdx < 2) return false;
	const nameStart = lastDot + 1;
	const nameLen = len - nameStart;
	if (nameLen === 0 || nameLen > 63) return false;
	if (!/* @__PURE__ */ isAsciiAlpha(input.charCodeAt(nameStart))) return false;
	for (let j = nameStart + 1; j < len; j++) if (!/* @__PURE__ */ isAsciiAlphaNum(input.charCodeAt(j))) return false;
	return true;
};

//#endregion
//#region ../../node_modules/.pnpm/@atcute+lexicons@2.0.0/node_modules/@atcute/lexicons/dist/syntax/record-key.js
const isRecordKey = /* @__NO_SIDE_EFFECTS__ */ (input) => {
	if (typeof input !== "string") return false;
	const len = input.length;
	if (len < 1 || len > 512) return false;
	if (len <= 2 && input.charCodeAt(0) === 46 && (len === 1 || input.charCodeAt(1) === 46)) return false;
	for (let i = 0; i < len; i++) {
		const c = input.charCodeAt(i);
		if (!/* @__PURE__ */ isAsciiAlphaNum(c) && c !== 95 && c !== 126 && c !== 46 && c !== 58 && c !== 45) return false;
	}
	return true;
};

//#endregion
//#region ../../node_modules/.pnpm/@atcute+lexicons@2.0.0/node_modules/@atcute/lexicons/dist/syntax/at-uri.js
const AT_URI_MIN_LENGTH = 8;
const AT_URI_MAX_LENGTH = 2884;
const isFragmentChar = (c) => {
	return /* @__PURE__ */ isAsciiAlphaNum(c) || c === 46 || c === 95 || c === 126 || c === 58 || c === 64 || c === 33 || c === 36 || c === 38 || c === 37 || c === 39 || c === 41 || c === 40 || c === 42 || c === 43 || c === 44 || c === 59 || c === 61 || c === 45 || c === 91 || c === 93 || c === 47 || c === 92;
};
const isResourceUri = /* @__NO_SIDE_EFFECTS__ */ (input) => {
	if (typeof input !== "string") return false;
	const len = input.length;
	if (len < AT_URI_MIN_LENGTH || len > AT_URI_MAX_LENGTH) return false;
	if (input.charCodeAt(0) !== 97 || input.charCodeAt(1) !== 116 || input.charCodeAt(2) !== 58 || input.charCodeAt(3) !== 47 || input.charCodeAt(4) !== 47) return false;
	const hash = input.indexOf("#", 5);
	const stop = hash === -1 ? len : hash;
	if (hash !== -1) {
		const fragmentStart = hash + 1;
		if (fragmentStart >= len || input.charCodeAt(fragmentStart) !== 47) return false;
		for (let idx = fragmentStart; idx < len; idx++) if (!isFragmentChar(input.charCodeAt(idx))) return false;
	}
	const firstSlash = input.indexOf("/", 5);
	let repoEnd = stop;
	let collection;
	let rkey;
	if (firstSlash !== -1 && firstSlash < stop) {
		repoEnd = firstSlash;
		const collectionStart = firstSlash + 1;
		if (collectionStart >= stop) return false;
		const secondSlash = input.indexOf("/", collectionStart);
		if (secondSlash !== -1 && secondSlash < stop) {
			if (secondSlash === collectionStart || secondSlash + 1 >= stop) return false;
			const thirdSlash = input.indexOf("/", secondSlash + 1);
			if (thirdSlash !== -1 && thirdSlash < stop) return false;
			collection = input.substring(collectionStart, secondSlash);
			rkey = input.substring(secondSlash + 1, stop);
		} else collection = input.substring(collectionStart, stop);
	}
	if (repoEnd <= 5) return false;
	return /* @__PURE__ */ isActorIdentifier(input.substring(5, repoEnd)) && (collection === void 0 || /* @__PURE__ */ isNsid(collection)) && (rkey === void 0 || /* @__PURE__ */ isRecordKey(rkey));
};

//#endregion
//#region ../../node_modules/.pnpm/@atcute+lexicons@2.0.0/node_modules/@atcute/lexicons/dist/syntax/cid.js
const DASL_CID_RE = /^baf[ky]rei[a-z2-7]{52}$/;
const isCid = /* @__NO_SIDE_EFFECTS__ */ (input) => {
	return typeof input === "string" && input.length === 59 && DASL_CID_RE.test(input);
};

//#endregion
//#region ../../node_modules/.pnpm/@atcute+lexicons@2.0.0/node_modules/@atcute/lexicons/dist/syntax/datetime.js
const DATE_TIME_RE = /^((?!0{3})\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01]))T((?:[01]\d|2[0-3]):(?:[0-5]\d):(?:[0-5]\d))(\.\d+)?(Z|(?!-00:00)[+-](?:[01]\d|2[0-3]):(?:[0-5]\d))$/;
const isDatetime = /* @__NO_SIDE_EFFECTS__ */ (input) => {
	return typeof input === "string" && input.length >= 20 && input.length <= 64 && DATE_TIME_RE.test(input);
};

//#endregion
//#region ../../node_modules/.pnpm/@atcute+lexicons@2.0.0/node_modules/@atcute/lexicons/dist/syntax/language.js
const LANGUAGE_CODE_RE = /^((?<grandfathered>(en-GB-oed|i-ami|i-bnn|i-default|i-enochian|i-hak|i-klingon|i-lux|i-mingo|i-navajo|i-pwn|i-tao|i-tay|i-tsu|sgn-BE-FR|sgn-BE-NL|sgn-CH-DE)|(art-lojban|cel-gaulish|no-bok|no-nyn|zh-guoyu|zh-hakka|zh-min|zh-min-nan|zh-xiang))|((?<language>([A-Za-z]{2,3}(-(?<extlang>[A-Za-z]{3}(-[A-Za-z]{3}){0,2}))?)|[A-Za-z]{4}|[A-Za-z]{5,8})(-(?<script>[A-Za-z]{4}))?(-(?<region>[A-Za-z]{2}|[0-9]{3}))?(-(?<variant>[A-Za-z0-9]{5,8}|[0-9][A-Za-z0-9]{3}))*(-(?<extension>[0-9A-WY-Za-wy-z](-[A-Za-z0-9]{2,8})+))*(-(?<privateUseA>x(-[A-Za-z0-9]{1,8})+))?)|(?<privateUseB>x(-[A-Za-z0-9]{1,8})+))$/;
const isLanguageCode = /* @__NO_SIDE_EFFECTS__ */ (input) => {
	return typeof input === "string" && input.length >= 2 && LANGUAGE_CODE_RE.test(input);
};

//#endregion
//#region ../../node_modules/.pnpm/@atcute+lexicons@2.0.0/node_modules/@atcute/lexicons/dist/syntax/tid.js
const TID_RE = /^[234567abcdefghij][234567abcdefghijklmnopqrstuvwxyz]{12}$/;
const isTid = /* @__NO_SIDE_EFFECTS__ */ (input) => {
	return typeof input === "string" && input.length === 13 && TID_RE.test(input);
};

//#endregion
//#region ../../node_modules/.pnpm/@atcute+uint8array@1.1.1/node_modules/@atcute/uint8array/dist/index.node.js
const _alloc = Buffer$1.alloc;
const _allocUnsafe = Buffer$1.allocUnsafe;
const _concat = Buffer$1.concat;
const _from = Buffer$1.from;
const _byteLength = Buffer$1.byteLength;
const _compare = Buffer$1.prototype.compare;
const _equals = Buffer$1.prototype.equals;
const _utf8Slice = Buffer$1.prototype.utf8Slice;
const _utf8Write = Buffer$1.prototype.utf8Write;
const toUint8Array = (buffer) => {
	return new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
};
const allocUnsafe = (size) => {
	return toUint8Array(_allocUnsafe(size));
};
const _fromCharCode$1 = String.fromCharCode;
/**
* checks if a string's UTF-8 byte length is within a given range
* @param str string to measure
* @param min minimum byte length (inclusive)
* @param max maximum byte length (inclusive)
* @returns true if byte length is within [min, max]
*/
const isUtf8LengthInRange = (str, min, max) => {
	const len = str.length;
	if (len * 3 < min) return false;
	if (len >= min && len * 3 <= max) return true;
	const utf8len = _byteLength(str, "utf8");
	return utf8len >= min && utf8len <= max;
};

//#endregion
//#region ../../node_modules/.pnpm/@atcute+lexicons@2.0.0/node_modules/@atcute/lexicons/dist/syntax/uri.js
const URI_RE = /^\w+:(?:\/\/)?[^\s/][^\s]*$/;
const isGenericUri = /* @__NO_SIDE_EFFECTS__ */ (input) => {
	if (typeof input !== "string") return false;
	if (!isUtf8LengthInRange(input, 3, 8192)) return false;
	return URI_RE.test(input);
};

//#endregion
//#region ../../packages/registry-lexicons/dist/chunk-BYypO7fO.js
var __defProp = Object.defineProperty;
var __exportAll = (all, no_symbols) => {
	let target = {};
	for (var name in all) __defProp(target, name, {
		get: all[name],
		enumerable: true
	});
	if (!no_symbols) __defProp(target, Symbol.toStringTag, { value: "Module" });
	return target;
};

//#endregion
//#region ../../node_modules/.pnpm/@atcute+lexicons@2.0.0/node_modules/@atcute/lexicons/dist/interfaces/cid-link.js
const CID_LINK_SYMBOL = Symbol.for("@atcute/cid-link-wrapper");
const isCidLink = (input) => {
	const v = input;
	return typeof v === "object" && v !== null && (CID_LINK_SYMBOL in v || /* @__PURE__ */ isCid(v.$link));
};

//#endregion
//#region ../../node_modules/.pnpm/@atcute+lexicons@2.0.0/node_modules/@atcute/lexicons/dist/interfaces/blob.js
const isBlob = (input) => {
	const v = input;
	return typeof v === "object" && v !== null && v.$type === "blob" && typeof v.mimeType === "string" && Number.isSafeInteger(v.size) && isCidLink(v.ref) && Object.keys(v).length === 4;
};
const isLegacyBlob = (input) => {
	const v = input;
	return typeof v === "object" && v !== null && typeof v.cid === "string" && typeof v.mimeType === "string" && Object.keys(v).length === 2;
};

//#endregion
//#region ../../node_modules/.pnpm/esm-env@1.2.2/node_modules/esm-env/dev-fallback.js
const node_env = globalThis.process?.env?.NODE_ENV;
var dev_fallback_default = node_env && !node_env.toLowerCase().startsWith("prod");

//#endregion
//#region ../../node_modules/.pnpm/@atcute+lexicons@2.0.0/node_modules/@atcute/lexicons/dist/utils.js
const assert = (condition, message) => {
	if (!condition) {
		if (dev_fallback_default) throw new Error(`Assertion failed` + (message ? `: ${message}` : ``));
		throw new Error(`Assertion failed`);
	}
};

//#endregion
//#region ../../node_modules/.pnpm/@atcute+lexicons@2.0.0/node_modules/@atcute/lexicons/dist/validations/utils.js
const lazyProperty = /* @__NO_SIDE_EFFECTS__ */ (obj, prop, value) => {
	Object.defineProperty(obj, prop, { value });
	return value;
};
const lazy = /* @__NO_SIDE_EFFECTS__ */ (getter) => {
	return { get value() {
		const value = getter();
		return /* @__PURE__ */ lazyProperty(this, "value", value);
	} };
};
const isArray = Array.isArray;
const isObject$1 = /* @__NO_SIDE_EFFECTS__ */ (input) => {
	return typeof input === "object" && input !== null && !isArray(input);
};
const allowsEval$1 = /* @__PURE__ */ lazy(() => {
	if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) return false;
	try {
		new Function("");
		return true;
	} catch {
		return false;
	}
});

//#endregion
//#region ../../node_modules/.pnpm/@atcute+lexicons@2.0.0/node_modules/@atcute/lexicons/dist/validations/index.js
const joinIssues = /* @__NO_SIDE_EFFECTS__ */ (left, right) => {
	return left ? {
		ok: false,
		code: "join",
		left,
		right
	} : right;
};
const prependPath = /* @__NO_SIDE_EFFECTS__ */ (key, tree) => {
	return {
		ok: false,
		code: "prepend",
		key,
		tree
	};
};
const ok = /* @__NO_SIDE_EFFECTS__ */ (value) => {
	return {
		ok: true,
		value
	};
};
const FLAG_EMPTY = 0;
const FLAG_ABORT_EARLY = 1;
const FLAG_STRICT = 2;
const cloneIssueWithPath = (issue, path) => {
	const { ok: _ok, msg: _fmt, ...clone } = issue;
	return {
		...clone,
		path
	};
};
const collectIssues = (tree, path = [], issues = []) => {
	for (;;) switch (tree.code) {
		case "join":
			collectIssues(tree.left, path.slice(), issues);
			tree = tree.right;
			continue;
		case "prepend":
			path.push(tree.key);
			tree = tree.tree;
			continue;
		default:
			issues.push(cloneIssueWithPath(tree, path));
			return issues;
	}
};
const countIssues = (tree) => {
	let count = 0;
	for (;;) switch (tree.code) {
		case "join":
			count += countIssues(tree.left);
			tree = tree.right;
			continue;
		case "prepend":
			tree = tree.tree;
			continue;
		default: return count + 1;
	}
};
const separatedList = (list, sep) => {
	switch (list.length) {
		case 0: return `nothing`;
		case 1: return list[0];
		default: return `${list.slice(0, -1).join(", ")} ${sep} ${list[list.length - 1]}`;
	}
};
const formatLiteral = (value) => {
	return JSON.stringify(value);
};
const formatRangeMessage = (type, unit, min, max) => {
	let message = `expected ${type} `;
	if (min > 0) if (max === min) message += `${min}`;
	else if (max !== Infinity) message += `between ${min} and ${max}`;
	else message += `at least ${min}`;
	else message += `at most ${max}`;
	message += ` ${unit}(s)`;
	return message;
};
const formatIssueTree = (tree) => {
	let path = "";
	let count = 0;
	for (;;) {
		switch (tree.code) {
			case "join":
				count += countIssues(tree.right);
				tree = tree.left;
				continue;
			case "prepend":
				path += `.${tree.key}`;
				tree = tree.tree;
				continue;
		}
		break;
	}
	const message = tree.msg();
	let msg = `${tree.code} at ${path || "."} (${message})`;
	if (count > 0) msg += ` (+${count} other issue(s))`;
	return msg;
};
var ValidationError = class extends Error {
	name = "ValidationError";
	#issueTree;
	constructor(issueTree) {
		super();
		this.#issueTree = issueTree;
	}
	get message() {
		return formatIssueTree(this.#issueTree);
	}
	get issues() {
		return collectIssues(this.#issueTree);
	}
};
var ErrImpl = class {
	ok = false;
	#issueTree;
	constructor(issueTree) {
		this.#issueTree = issueTree;
	}
	get message() {
		return formatIssueTree(this.#issueTree);
	}
	get issues() {
		return collectIssues(this.#issueTree);
	}
	throw() {
		throw new ValidationError(this.#issueTree);
	}
};
const safeParse$2 = /* @__NO_SIDE_EFFECTS__ */ (schema, input, options) => {
	let flags = FLAG_EMPTY;
	if (options?.strict) flags |= FLAG_STRICT;
	const r = schema["~run"](input, flags);
	if (r === void 0) return /* @__PURE__ */ ok(input);
	if (r.ok) return r;
	return new ErrImpl(r);
};
const collectStandardIssues = (tree, path = [], issues = []) => {
	for (;;) switch (tree.code) {
		case "join":
			collectStandardIssues(tree.left, path.slice(), issues);
			tree = tree.right;
			continue;
		case "prepend":
			path.push(tree.key);
			tree = tree.tree;
			continue;
		default:
			issues.push({
				message: tree.msg(),
				path: path.length > 0 ? path : void 0
			});
			return issues;
	}
};
const toStandardSchema = (schema) => {
	return {
		version: 1,
		vendor: "@atcute/lexicons",
		validate(value) {
			const r = schema["~run"](value, FLAG_EMPTY);
			if (r === void 0) return { value };
			if (r.ok) return { value: r.value };
			return { issues: collectStandardIssues(r) };
		}
	};
};
const constrain = /* @__NO_SIDE_EFFECTS__ */ (base, constraints) => {
	const len = constraints.length;
	return {
		...base,
		constraints,
		"~run"(input, flags) {
			let result = base["~run"](input, flags);
			let current;
			if (result === void 0) current = input;
			else if (result.ok) current = result.value;
			else return result;
			for (let idx = 0; idx < len; idx++) {
				const r = constraints[idx]["~run"](current, flags);
				if (r !== void 0) if (r.ok) {
					current = r.value;
					if (result === void 0 || result.ok) result = r;
				} else if (flags & FLAG_ABORT_EARLY) return r;
				else if (result === void 0 || result.ok) result = r;
				else result = /* @__PURE__ */ joinIssues(result, r);
			}
			return result;
		}
	};
};
const literal$1 = /* @__NO_SIDE_EFFECTS__ */ (value) => {
	const issue = {
		ok: false,
		code: "invalid_literal",
		expected: [value],
		msg() {
			return `expected ${formatLiteral(value)}`;
		}
	};
	return {
		kind: "schema",
		type: "literal",
		expected: value,
		"~run"(input, _flags) {
			if (input !== value) return issue;
		},
		get "~standard"() {
			return /* @__PURE__ */ lazyProperty(this, "~standard", toStandardSchema(this));
		}
	};
};
const ISSUE_TYPE_BOOLEAN = {
	ok: false,
	code: "invalid_type",
	expected: "boolean",
	msg() {
		return `expected boolean`;
	}
};
const BOOLEAN_SCHEMA = {
	kind: "schema",
	type: "boolean",
	"~run"(input, _flags) {
		if (typeof input !== "boolean") return ISSUE_TYPE_BOOLEAN;
	},
	get "~standard"() {
		return /* @__PURE__ */ lazyProperty(this, "~standard", toStandardSchema(this));
	}
};
const boolean$2 = /* @__NO_SIDE_EFFECTS__ */ () => {
	return BOOLEAN_SCHEMA;
};
const ISSUE_TYPE_INTEGER = {
	ok: false,
	code: "invalid_type",
	expected: "integer",
	msg() {
		return `expected integer`;
	}
};
const INTEGER_SCHEMA = {
	kind: "schema",
	type: "integer",
	"~run"(input, _flags) {
		if (typeof input !== "number") return ISSUE_TYPE_INTEGER;
		if (input < 0 || !Number.isSafeInteger(input)) return ISSUE_TYPE_INTEGER;
	},
	get "~standard"() {
		return /* @__PURE__ */ lazyProperty(this, "~standard", toStandardSchema(this));
	}
};
const integer$1 = /* @__NO_SIDE_EFFECTS__ */ () => {
	return INTEGER_SCHEMA;
};
const integerRange = /* @__NO_SIDE_EFFECTS__ */ (min, max = Infinity) => {
	const issue = {
		ok: false,
		code: "invalid_integer_range",
		min,
		max,
		msg() {
			let message = `expected an integer `;
			if (min > 0) if (max === min) message += `of exactly ${min}`;
			else if (max !== Infinity) message += `between ${min} and ${max}`;
			else message += `of at least ${min}`;
			else message += `of at most ${max}`;
			return message;
		}
	};
	return {
		kind: "constraint",
		type: "integer_range",
		min,
		max,
		"~run"(input, _flags) {
			if (input < min) return issue;
			if (input > max) return issue;
		}
	};
};
const ISSUE_TYPE_STRING = {
	ok: false,
	code: "invalid_type",
	expected: "string",
	msg() {
		return `expected string`;
	}
};
const STRING_SINGLETON = {
	kind: "schema",
	type: "string",
	format: null,
	"~run"(input, _flags) {
		if (typeof input !== "string") return ISSUE_TYPE_STRING;
	},
	get "~standard"() {
		return /* @__PURE__ */ lazyProperty(this, "~standard", toStandardSchema(this));
	}
};
const string$2 = /* @__NO_SIDE_EFFECTS__ */ () => {
	return STRING_SINGLETON;
};
const _formattedString = /* @__NO_SIDE_EFFECTS__ */ (format, validate) => {
	const issue = {
		ok: false,
		code: "invalid_string_format",
		expected: format,
		msg() {
			return `expected a ${format} formatted string`;
		}
	};
	const schema = {
		kind: "schema",
		type: "string",
		format,
		"~run"(input, _flags) {
			if (typeof input !== "string") return ISSUE_TYPE_STRING;
			if (!validate(input)) return issue;
		},
		get "~standard"() {
			return /* @__PURE__ */ lazyProperty(this, "~standard", toStandardSchema(this));
		}
	};
	return () => schema;
};
const actorIdentifierString = /* @__PURE__ */ _formattedString("at-identifier", isActorIdentifier);
const resourceUriString = /* @__PURE__ */ _formattedString("at-uri", isResourceUri);
const cidString = /* @__PURE__ */ _formattedString("cid", isCid);
const datetimeString = /* @__PURE__ */ _formattedString("datetime", isDatetime);
const didString = /* @__PURE__ */ _formattedString("did", isDid);
const handleString = /* @__PURE__ */ _formattedString("handle", isHandle);
const languageCodeString = /* @__PURE__ */ _formattedString("language", isLanguageCode);
const nsidString = /* @__PURE__ */ _formattedString("nsid", isNsid);
const recordKeyString = /* @__PURE__ */ _formattedString("record-key", isRecordKey);
const tidString = /* @__PURE__ */ _formattedString("tid", isTid);
const genericUriString = /* @__PURE__ */ _formattedString("uri", isGenericUri);
const stringLength = /* @__NO_SIDE_EFFECTS__ */ (minLength, maxLength = Infinity) => {
	const issue = {
		ok: false,
		code: "invalid_string_length",
		minLength,
		maxLength,
		msg() {
			return formatRangeMessage("a string", "character", minLength, maxLength);
		}
	};
	return {
		kind: "constraint",
		type: "string_length",
		minLength,
		maxLength,
		"~run"(input, _flags) {
			if (!isUtf8LengthInRange(input, minLength, maxLength)) return issue;
		}
	};
};
const ISSUE_EXPECTED_BLOB = {
	ok: false,
	code: "invalid_type",
	expected: "blob",
	msg() {
		return `expected blob`;
	}
};
const BLOB_SCHEMA = {
	kind: "schema",
	type: "blob",
	"~run"(input, flags) {
		if (typeof input !== "object" || input === null) return ISSUE_EXPECTED_BLOB;
		if (isBlob(input)) return;
		if (!(flags & FLAG_STRICT) && isLegacyBlob(input)) return /* @__PURE__ */ ok({
			$type: "blob",
			mimeType: input.mimeType,
			ref: { $link: input.cid },
			size: -1
		});
		return ISSUE_EXPECTED_BLOB;
	},
	get "~standard"() {
		return /* @__PURE__ */ lazyProperty(this, "~standard", toStandardSchema(this));
	}
};
const blob = /* @__NO_SIDE_EFFECTS__ */ () => {
	return BLOB_SCHEMA;
};
const blobSize = /* @__NO_SIDE_EFFECTS__ */ (maxSize) => {
	const issue = {
		ok: false,
		code: "invalid_blob_size",
		maxSize,
		msg() {
			return `blob size must not exceed ${maxSize} bytes`;
		}
	};
	return {
		kind: "constraint",
		type: "blob_size",
		maxSize,
		"~run"(input, flags) {
			if (!(flags & FLAG_STRICT)) return;
			if (input.size > maxSize) return issue;
		}
	};
};
const blobAccept = /* @__NO_SIDE_EFFECTS__ */ (accept) => {
	const normalized = accept.map((p) => p.toLowerCase());
	const issue = {
		ok: false,
		code: "invalid_blob_mime_type",
		accept,
		msg() {
			return `blob MIME type must match: ${accept.join(", ")}`;
		}
	};
	return {
		kind: "constraint",
		type: "blob_accept",
		accept,
		"~run"(input, flags) {
			if (!(flags & FLAG_STRICT)) return;
			const mimeType = input.mimeType.toLowerCase();
			for (let idx = 0, len = normalized.length; idx < len; idx++) {
				const pattern = normalized[idx];
				if (pattern === "*/*") return;
				if (pattern.endsWith("/*")) {
					if (mimeType.startsWith(pattern.slice(0, -1))) return;
				} else if (mimeType === pattern) return;
			}
			return issue;
		}
	};
};
const optional$1 = /* @__NO_SIDE_EFFECTS__ */ (wrapped, defaultValue) => {
	return {
		kind: "schema",
		type: "optional",
		wrapped,
		default: defaultValue,
		"~run"(input, flags) {
			if (input === void 0) {
				if (defaultValue === void 0) return;
				return /* @__PURE__ */ ok(typeof defaultValue === "function" ? defaultValue() : defaultValue);
			}
			return wrapped["~run"](input, flags);
		},
		get "~standard"() {
			return /* @__PURE__ */ lazyProperty(this, "~standard", toStandardSchema(this));
		}
	};
};
const isOptionalSchema = (schema) => {
	return schema.type === "optional";
};
const ISSUE_TYPE_ARRAY = {
	ok: false,
	code: "invalid_type",
	expected: "array",
	msg() {
		return `expected array`;
	}
};
const array$1 = /* @__NO_SIDE_EFFECTS__ */ (item) => {
	const resolvedShape = /* @__PURE__ */ lazy(() => {
		return typeof item === "function" ? item() : item;
	});
	return {
		kind: "schema",
		type: "array",
		get item() {
			return /* @__PURE__ */ lazyProperty(this, "item", resolvedShape.value);
		},
		get "~run"() {
			const shape = resolvedShape.value;
			const matcher = (input, flags) => {
				if (!isArray(input)) return ISSUE_TYPE_ARRAY;
				let issues;
				let output;
				for (let idx = 0, len = input.length; idx < len; idx++) {
					const val = input[idx];
					const r = shape["~run"](val, flags);
					if (r !== void 0) if (r.ok) {
						if (output === void 0) output = input.slice();
						output[idx] = r.value;
					} else {
						if (flags & FLAG_ABORT_EARLY) return /* @__PURE__ */ prependPath(idx, r);
						issues = /* @__PURE__ */ joinIssues(issues, /* @__PURE__ */ prependPath(idx, r));
					}
				}
				if (issues !== void 0) return issues;
				if (output !== void 0) return /* @__PURE__ */ ok(output);
			};
			return /* @__PURE__ */ lazyProperty(this, "~run", matcher);
		},
		get "~standard"() {
			return /* @__PURE__ */ lazyProperty(this, "~standard", toStandardSchema(this));
		}
	};
};
const arrayLength = /* @__NO_SIDE_EFFECTS__ */ (minLength, maxLength = Infinity) => {
	const issue = {
		ok: false,
		code: "invalid_array_length",
		minLength,
		maxLength,
		msg() {
			return formatRangeMessage("an array", "item", minLength, maxLength);
		}
	};
	return {
		kind: "constraint",
		type: "array_length",
		minLength,
		maxLength,
		"~run"(input, _flags) {
			const length = input.length;
			if (length < minLength) return issue;
			if (length > maxLength) return issue;
		}
	};
};
const ISSUE_TYPE_OBJECT = {
	ok: false,
	code: "invalid_type",
	expected: "object",
	msg() {
		return `expected object`;
	}
};
const ISSUE_MISSING = {
	ok: false,
	code: "missing_value",
	msg() {
		return `missing value`;
	}
};
const set = (obj, key, value) => {
	if (key === "__proto__") Object.defineProperty(obj, key, { value });
	else obj[key] = value;
};
const object$1 = /* @__NO_SIDE_EFFECTS__ */ (shape) => {
	const resolvedEntries = /* @__PURE__ */ lazy(() => {
		const resolved = [];
		for (const key in shape) {
			const schema = shape[key];
			resolved.push({
				key,
				schema,
				optional: isOptionalSchema(schema),
				missing: /* @__PURE__ */ prependPath(key, ISSUE_MISSING)
			});
		}
		return resolved;
	});
	return {
		kind: "schema",
		type: "object",
		get shape() {
			const resolved = resolvedEntries.value;
			const obj = {};
			for (const entry of resolved) obj[entry.key] = entry.schema;
			return /* @__PURE__ */ lazyProperty(this, "shape", obj);
		},
		get "~run"() {
			const shape = resolvedEntries.value;
			const len = shape.length;
			const generateFastpass = () => {
				const fields = [
					["$ok", ok],
					["$joinIssues", joinIssues],
					["$prependPath", prependPath]
				];
				let doc = `let $iss,$out;`;
				for (let idx = 0; idx < len; idx++) {
					const entry = shape[idx];
					const key = entry.key;
					const esckey = JSON.stringify(key);
					const id = `_${idx}`;
					doc += `{const $val=$in[${esckey}];`;
					if (entry.optional) doc += `if($val!==undefined){`;
					else doc += `if($val!==undefined||${esckey} in $in){`;
					doc += `const $res=${id}$schema["~run"]($val,$flags);if($res!==undefined)if($res.ok)${key !== "__proto__" ? `($out??={...$in})[${esckey}]=$res.value` : `Object.defineProperty($out??={...$in},${esckey},{value:$res.value})`};else if((($iss=$joinIssues($iss,$prependPath(${esckey},$res))),$flags&${FLAG_ABORT_EARLY}))return $iss;}`;
					if (entry.optional) {
						const schema = entry.schema;
						const innerSchema = schema.wrapped;
						const defaultValue = schema.default;
						fields.push([`${id}$schema`, innerSchema]);
						if (defaultValue !== void 0) {
							const calls = typeof defaultValue === "function" ? `${id}$default()` : `${id}$default`;
							fields.push([`${id}$default`, defaultValue]);
							doc += key !== "__proto__" ? `else($out??={...$in})[${esckey}]=${calls};` : `else Object.defineProperty($out??={...$in},${esckey},{value:${calls}});`;
						}
					} else {
						fields.push([`${id}$schema`, entry.schema]);
						fields.push([`${id}$missing`, entry.missing]);
						doc += `else if((($iss=$joinIssues($iss,${id}$missing)),$flags&${FLAG_ABORT_EARLY}))return $iss;`;
					}
					doc += `}`;
				}
				doc += `if($iss!==undefined)return $iss;if($out!==undefined)return $ok($out);`;
				return new Function(`[${fields.map(([id]) => id).join(",")}]`, `return function matcher($in,$flags){${doc}}`)(fields.map(([, field]) => field));
			};
			if (allowsEval$1.value) {
				const fastpass = generateFastpass();
				const matcher = (input, flags) => {
					if (!/* @__PURE__ */ isObject$1(input)) return ISSUE_TYPE_OBJECT;
					return fastpass(input, flags);
				};
				return /* @__PURE__ */ lazyProperty(this, "~run", matcher);
			}
			const matcher = (input, flags) => {
				if (!/* @__PURE__ */ isObject$1(input)) return ISSUE_TYPE_OBJECT;
				let issues;
				let output;
				for (let idx = 0; idx < len; idx++) {
					const entry = shape[idx];
					const key = entry.key;
					const value = input[key];
					if (!entry.optional && value === void 0 && !(key in input)) {
						issues = /* @__PURE__ */ joinIssues(issues, entry.missing);
						if (flags & FLAG_ABORT_EARLY) return issues;
						continue;
					}
					const r = entry.schema["~run"](value, flags);
					if (r !== void 0) if (r.ok) {
						if (output === void 0) output = { ...input };
						set(output, key, r.value);
					} else {
						issues = /* @__PURE__ */ joinIssues(issues, /* @__PURE__ */ prependPath(key, r));
						if (flags & FLAG_ABORT_EARLY) return issues;
					}
				}
				if (issues !== void 0) return issues;
				if (output !== void 0) return /* @__PURE__ */ ok(output);
			};
			return /* @__PURE__ */ lazyProperty(this, "~run", matcher);
		},
		get "~standard"() {
			return /* @__PURE__ */ lazyProperty(this, "~standard", toStandardSchema(this));
		}
	};
};
const record$1 = /* @__NO_SIDE_EFFECTS__ */ (key, object) => {
	const validatedObject = /* @__PURE__ */ lazy(() => {
		let t = object.shape.$type;
		assert(t !== void 0, `expected $type in record to be defined`);
		if (t.type === "optional") t = t.wrapped;
		assert(t.type === "literal" && typeof t.expected === "string", `expected $type to be a string literal`);
		return object;
	});
	return {
		kind: "schema",
		type: "record",
		key,
		get object() {
			return /* @__PURE__ */ lazyProperty(this, "object", validatedObject.value);
		},
		"~run"(input, flags) {
			return (/* @__PURE__ */ lazyProperty(this, "~run", validatedObject.value["~run"]))(input, flags);
		},
		get "~standard"() {
			return /* @__PURE__ */ lazyProperty(this, "~standard", toStandardSchema(this));
		}
	};
};
const ISSUE_VARIANT_MISSING = /* @__PURE__ */ prependPath("$type", ISSUE_MISSING);
const ISSUE_VARIANT_TYPE = /* @__PURE__ */ prependPath("$type", ISSUE_TYPE_STRING);
const variant = /* @__NO_SIDE_EFFECTS__ */ (members, closed = false) => {
	return {
		kind: "schema",
		type: "variant",
		members,
		closed,
		get "~run"() {
			const types = [];
			const schemas = [];
			for (let idx = 0, len = members.length; idx < len; idx++) {
				const raw = members[idx];
				const member = raw.type === "record" ? raw.object : raw;
				let t = member.shape.$type;
				assert(t !== void 0, `expected $type in variant member #${idx} to be defined`);
				if (t.type === "optional") t = t.wrapped;
				assert(t.type === "literal" && typeof t.expected === "string", `expected $type in variant member #${idx} to be a string literal`);
				types.push(t.expected);
				schemas.push(member);
			}
			const issue = {
				ok: false,
				code: "invalid_variant",
				expected: types,
				msg() {
					return `expected ${separatedList(types, "or")}`;
				}
			};
			const matcher = (input, flags) => {
				if (!/* @__PURE__ */ isObject$1(input)) return ISSUE_TYPE_OBJECT;
				const type = input.$type;
				if (type === void 0 && !("$type" in input)) return ISSUE_VARIANT_MISSING;
				if (typeof type !== "string") return closed ? issue : ISSUE_VARIANT_TYPE;
				for (let idx = 0, len = types.length; idx < len; idx++) if (types[idx] === type) return schemas[idx]["~run"](input, flags);
				if (closed) return issue;
			};
			return /* @__PURE__ */ lazyProperty(this, "~run", matcher);
		},
		get "~standard"() {
			return /* @__PURE__ */ lazyProperty(this, "~standard", toStandardSchema(this));
		}
	};
};
const ISSUE_TYPE_UNKNOWN = {
	ok: false,
	code: "invalid_type",
	expected: "unknown",
	msg() {
		return `expected unknown`;
	}
};
const UNKNOWN_SCHEMA = {
	kind: "schema",
	type: "unknown",
	"~run"(input, _flags) {
		if (typeof input !== "object" || input === null) return ISSUE_TYPE_UNKNOWN;
	},
	get "~standard"() {
		return /* @__PURE__ */ lazyProperty(this, "~standard", toStandardSchema(this));
	}
};
const unknown$1 = /* @__NO_SIDE_EFFECTS__ */ () => {
	return UNKNOWN_SCHEMA;
};

//#endregion
//#region ../../packages/registry-lexicons/dist/generated/types/com/emdashcms/experimental/package/release.js
var release_exports = /* @__PURE__ */ __exportAll({
	artifactSchema: () => artifactSchema,
	artifactsSchema: () => artifactsSchema,
	imageArtifactSchema: () => imageArtifactSchema,
	mainSchema: () => mainSchema$1,
	sbomSchema: () => sbomSchema
});
const _artifactSchema = /* @__PURE__ */ object$1({
	$type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.release#artifact")),
	blob: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ blob(), [/* @__PURE__ */ blobSize(262144), /* @__PURE__ */ blobAccept(["application/gzip"])])),
	checksum: /* @__PURE__ */ constrain(/* @__PURE__ */ string$2(), [/* @__PURE__ */ stringLength(0, 256)]),
	contentType: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ string$2(), [/* @__PURE__ */ stringLength(0, 256)])),
	height: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ integer$1(), [/* @__PURE__ */ integerRange(1, 8192)])),
	id: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ string$2(), [/* @__PURE__ */ stringLength(0, 128)])),
	lang: /* @__PURE__ */ optional$1(/* @__PURE__ */ languageCodeString()),
	releaseAsset: /* @__PURE__ */ optional$1(/* @__PURE__ */ boolean$2()),
	requiresAuth: /* @__PURE__ */ optional$1(/* @__PURE__ */ boolean$2()),
	signature: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ string$2(), [/* @__PURE__ */ stringLength(0, 1024)])),
	url: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ genericUriString(), [/* @__PURE__ */ stringLength(0, 2048)])),
	width: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ integer$1(), [/* @__PURE__ */ integerRange(1, 8192)]))
});
const _artifactsSchema = /* @__PURE__ */ object$1({
	$type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.release#artifacts")),
	get banner() {
		return /* @__PURE__ */ optional$1(imageArtifactSchema);
	},
	get icon() {
		return /* @__PURE__ */ optional$1(imageArtifactSchema);
	},
	get package() {
		return artifactSchema;
	},
	get screenshots() {
		return /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ array$1(imageArtifactSchema), [/* @__PURE__ */ arrayLength(0, 8)]));
	}
});
const _imageArtifactSchema = /* @__PURE__ */ object$1({
	$type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.release#imageArtifact")),
	blob: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ blob(), [/* @__PURE__ */ blobSize(1048576), /* @__PURE__ */ blobAccept([
		"image/png",
		"image/jpeg",
		"image/webp"
	])])),
	checksum: /* @__PURE__ */ constrain(/* @__PURE__ */ string$2(), [/* @__PURE__ */ stringLength(0, 256)]),
	contentType: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ string$2(), [/* @__PURE__ */ stringLength(0, 256)])),
	height: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ integer$1(), [/* @__PURE__ */ integerRange(1, 8192)])),
	id: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ string$2(), [/* @__PURE__ */ stringLength(0, 128)])),
	lang: /* @__PURE__ */ optional$1(/* @__PURE__ */ languageCodeString()),
	releaseAsset: /* @__PURE__ */ optional$1(/* @__PURE__ */ boolean$2()),
	requiresAuth: /* @__PURE__ */ optional$1(/* @__PURE__ */ boolean$2()),
	signature: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ string$2(), [/* @__PURE__ */ stringLength(0, 1024)])),
	url: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ genericUriString(), [/* @__PURE__ */ stringLength(0, 2048)])),
	width: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ integer$1(), [/* @__PURE__ */ integerRange(1, 8192)]))
});
const _mainSchema$1 = /* @__PURE__ */ record$1(/* @__PURE__ */ string$2(), /* @__PURE__ */ object$1({
	$type: /* @__PURE__ */ literal$1("com.emdashcms.experimental.package.release"),
	get artifacts() {
		return artifactsSchema;
	},
	get auth() {
		return /* @__PURE__ */ optional$1(/* @__PURE__ */ variant([]));
	},
	extensions: /* @__PURE__ */ optional$1(/* @__PURE__ */ unknown$1()),
	package: /* @__PURE__ */ constrain(/* @__PURE__ */ string$2(), [/* @__PURE__ */ stringLength(1, 64)]),
	provides: /* @__PURE__ */ optional$1(/* @__PURE__ */ unknown$1()),
	repo: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ genericUriString(), [/* @__PURE__ */ stringLength(0, 1024)])),
	requires: /* @__PURE__ */ optional$1(/* @__PURE__ */ unknown$1()),
	get sbom() {
		return /* @__PURE__ */ optional$1(sbomSchema);
	},
	suggests: /* @__PURE__ */ optional$1(/* @__PURE__ */ unknown$1()),
	version: /* @__PURE__ */ constrain(/* @__PURE__ */ string$2(), [/* @__PURE__ */ stringLength(1, 64)])
}));
const _sbomSchema = /* @__PURE__ */ object$1({
	$type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.release#sbom")),
	checksum: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ string$2(), [/* @__PURE__ */ stringLength(0, 256)])),
	format: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ string$2(), [/* @__PURE__ */ stringLength(0, 32)])),
	url: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ genericUriString(), [/* @__PURE__ */ stringLength(0, 2048)]))
});
const artifactSchema = _artifactSchema;
const artifactsSchema = _artifactsSchema;
const imageArtifactSchema = _imageArtifactSchema;
const mainSchema$1 = _mainSchema$1;
const sbomSchema = _sbomSchema;

//#endregion
//#region ../../packages/registry-lexicons/dist/generated/types/com/emdashcms/experimental/package/releaseExtension.js
var releaseExtension_exports = /* @__PURE__ */ __exportAll({
	contentAccessSchema: () => contentAccessSchema,
	contentReadConstraintsSchema: () => contentReadConstraintsSchema,
	contentWriteConstraintsSchema: () => contentWriteConstraintsSchema,
	declaredAccessSchema: () => declaredAccessSchema$1,
	emailAccessSchema: () => emailAccessSchema,
	emailEventsConstraintsSchema: () => emailEventsConstraintsSchema,
	emailSendConstraintsSchema: () => emailSendConstraintsSchema,
	emailTransportConstraintsSchema: () => emailTransportConstraintsSchema,
	mainSchema: () => mainSchema,
	mediaAccessSchema: () => mediaAccessSchema,
	mediaReadConstraintsSchema: () => mediaReadConstraintsSchema,
	mediaWriteConstraintsSchema: () => mediaWriteConstraintsSchema,
	networkAccessSchema: () => networkAccessSchema,
	networkRequestConstraintsSchema: () => networkRequestConstraintsSchema,
	pageAccessSchema: () => pageAccessSchema,
	pageFragmentsConstraintsSchema: () => pageFragmentsConstraintsSchema,
	provenanceSchema: () => provenanceSchema,
	taxonomiesAccessSchema: () => taxonomiesAccessSchema,
	taxonomiesReadConstraintsSchema: () => taxonomiesReadConstraintsSchema,
	usersAccessSchema: () => usersAccessSchema,
	usersReadConstraintsSchema: () => usersReadConstraintsSchema
});
const _contentAccessSchema = /* @__PURE__ */ object$1({
	$type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#contentAccess")),
	get read() {
		return /* @__PURE__ */ optional$1(contentReadConstraintsSchema);
	},
	get write() {
		return /* @__PURE__ */ optional$1(contentWriteConstraintsSchema);
	}
});
const _contentReadConstraintsSchema = /* @__PURE__ */ object$1({ $type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#contentReadConstraints")) });
const _contentWriteConstraintsSchema = /* @__PURE__ */ object$1({ $type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#contentWriteConstraints")) });
const _declaredAccessSchema = /* @__PURE__ */ object$1({
	$type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#declaredAccess")),
	get content() {
		return /* @__PURE__ */ optional$1(contentAccessSchema);
	},
	get email() {
		return /* @__PURE__ */ optional$1(emailAccessSchema);
	},
	get media() {
		return /* @__PURE__ */ optional$1(mediaAccessSchema);
	},
	get network() {
		return /* @__PURE__ */ optional$1(networkAccessSchema);
	},
	get page() {
		return /* @__PURE__ */ optional$1(pageAccessSchema);
	},
	get taxonomies() {
		return /* @__PURE__ */ optional$1(taxonomiesAccessSchema);
	},
	get users() {
		return /* @__PURE__ */ optional$1(usersAccessSchema);
	}
});
const _emailAccessSchema = /* @__PURE__ */ object$1({
	$type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#emailAccess")),
	get events() {
		return /* @__PURE__ */ optional$1(emailEventsConstraintsSchema);
	},
	get send() {
		return /* @__PURE__ */ optional$1(emailSendConstraintsSchema);
	},
	get transport() {
		return /* @__PURE__ */ optional$1(emailTransportConstraintsSchema);
	}
});
const _emailEventsConstraintsSchema = /* @__PURE__ */ object$1({ $type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#emailEventsConstraints")) });
const _emailSendConstraintsSchema = /* @__PURE__ */ object$1({ $type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#emailSendConstraints")) });
const _emailTransportConstraintsSchema = /* @__PURE__ */ object$1({ $type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#emailTransportConstraints")) });
const _mainSchema = /* @__PURE__ */ object$1({
	$type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension")),
	get declaredAccess() {
		return declaredAccessSchema$1;
	},
	get provenance() {
		return /* @__PURE__ */ optional$1(provenanceSchema);
	}
});
const _mediaAccessSchema = /* @__PURE__ */ object$1({
	$type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#mediaAccess")),
	get read() {
		return /* @__PURE__ */ optional$1(mediaReadConstraintsSchema);
	},
	get write() {
		return /* @__PURE__ */ optional$1(mediaWriteConstraintsSchema);
	}
});
const _mediaReadConstraintsSchema = /* @__PURE__ */ object$1({ $type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#mediaReadConstraints")) });
const _mediaWriteConstraintsSchema = /* @__PURE__ */ object$1({ $type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#mediaWriteConstraints")) });
const _networkAccessSchema = /* @__PURE__ */ object$1({
	$type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#networkAccess")),
	get request() {
		return /* @__PURE__ */ optional$1(networkRequestConstraintsSchema);
	}
});
const _networkRequestConstraintsSchema = /* @__PURE__ */ object$1({
	$type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#networkRequestConstraints")),
	allowedHosts: /* @__PURE__ */ optional$1(/* @__PURE__ */ constrain(/* @__PURE__ */ array$1(/* @__PURE__ */ constrain(/* @__PURE__ */ string$2(), [/* @__PURE__ */ stringLength(0, 256)])), [/* @__PURE__ */ arrayLength(1, 64)]))
});
const _pageAccessSchema = /* @__PURE__ */ object$1({
	$type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#pageAccess")),
	get fragments() {
		return /* @__PURE__ */ optional$1(pageFragmentsConstraintsSchema);
	}
});
const _pageFragmentsConstraintsSchema = /* @__PURE__ */ object$1({ $type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#pageFragmentsConstraints")) });
const _provenanceSchema = /* @__PURE__ */ object$1({
	$type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#provenance")),
	builderId: /* @__PURE__ */ constrain(/* @__PURE__ */ genericUriString(), [/* @__PURE__ */ stringLength(0, 1024)]),
	checksum: /* @__PURE__ */ constrain(/* @__PURE__ */ string$2(), [/* @__PURE__ */ stringLength(0, 256)]),
	predicateType: /* @__PURE__ */ constrain(/* @__PURE__ */ string$2(), [/* @__PURE__ */ stringLength(0, 1024)]),
	sourceRepository: /* @__PURE__ */ constrain(/* @__PURE__ */ genericUriString(), [/* @__PURE__ */ stringLength(0, 1024)]),
	url: /* @__PURE__ */ constrain(/* @__PURE__ */ genericUriString(), [/* @__PURE__ */ stringLength(0, 2048)])
});
const _taxonomiesAccessSchema = /* @__PURE__ */ object$1({
	$type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#taxonomiesAccess")),
	get read() {
		return /* @__PURE__ */ optional$1(taxonomiesReadConstraintsSchema);
	}
});
const _taxonomiesReadConstraintsSchema = /* @__PURE__ */ object$1({ $type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#taxonomiesReadConstraints")) });
const _usersAccessSchema = /* @__PURE__ */ object$1({
	$type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#usersAccess")),
	get read() {
		return /* @__PURE__ */ optional$1(usersReadConstraintsSchema);
	}
});
const _usersReadConstraintsSchema = /* @__PURE__ */ object$1({ $type: /* @__PURE__ */ optional$1(/* @__PURE__ */ literal$1("com.emdashcms.experimental.package.releaseExtension#usersReadConstraints")) });
const contentAccessSchema = _contentAccessSchema;
const contentReadConstraintsSchema = _contentReadConstraintsSchema;
const contentWriteConstraintsSchema = _contentWriteConstraintsSchema;
const declaredAccessSchema$1 = _declaredAccessSchema;
const emailAccessSchema = _emailAccessSchema;
const emailEventsConstraintsSchema = _emailEventsConstraintsSchema;
const emailSendConstraintsSchema = _emailSendConstraintsSchema;
const emailTransportConstraintsSchema = _emailTransportConstraintsSchema;
const mainSchema = _mainSchema;
const mediaAccessSchema = _mediaAccessSchema;
const mediaReadConstraintsSchema = _mediaReadConstraintsSchema;
const mediaWriteConstraintsSchema = _mediaWriteConstraintsSchema;
const networkAccessSchema = _networkAccessSchema;
const networkRequestConstraintsSchema = _networkRequestConstraintsSchema;
const pageAccessSchema = _pageAccessSchema;
const pageFragmentsConstraintsSchema = _pageFragmentsConstraintsSchema;
const provenanceSchema = _provenanceSchema;
const taxonomiesAccessSchema = _taxonomiesAccessSchema;
const taxonomiesReadConstraintsSchema = _taxonomiesReadConstraintsSchema;
const usersAccessSchema = _usersAccessSchema;
const usersReadConstraintsSchema = _usersReadConstraintsSchema;

//#endregion
//#region ../../packages/registry-lexicons/dist/index.js
/**
* NSID constants for the lexicons defined by this package. Useful for consumers
* that need to reference a record collection by string (e.g. when issuing
* `listRecords` or `putRecord` calls against a PDS).
*/
const NSID = {
	packageProfile: "com.emdashcms.experimental.package.profile",
	packageProfileExtension: "com.emdashcms.experimental.package.profileExtension",
	packageRelease: "com.emdashcms.experimental.package.release",
	packageReleaseExtension: "com.emdashcms.experimental.package.releaseExtension",
	publisherProfile: "com.emdashcms.experimental.publisher.profile",
	publisherVerification: "com.emdashcms.experimental.publisher.verification",
	aggregatorDefs: "com.emdashcms.experimental.aggregator.defs",
	aggregatorGetLatestRelease: "com.emdashcms.experimental.aggregator.getLatestRelease",
	aggregatorGetPackage: "com.emdashcms.experimental.aggregator.getPackage",
	aggregatorListReleases: "com.emdashcms.experimental.aggregator.listReleases",
	aggregatorResolvePackage: "com.emdashcms.experimental.aggregator.resolvePackage",
	aggregatorSearchPackages: "com.emdashcms.experimental.aggregator.searchPackages",
	labelerDefs: "com.emdashcms.experimental.labeler.defs",
	labelerGetAssessment: "com.emdashcms.experimental.labeler.getAssessment",
	labelerGetCurrentAssessment: "com.emdashcms.experimental.labeler.getCurrentAssessment",
	labelerGetPolicy: "com.emdashcms.experimental.labeler.getPolicy",
	labelerListAssessments: "com.emdashcms.experimental.labeler.listAssessments"
};
const RECORD_SCOPED_BLOB_CACHE_TYPE = `${NSID.aggregatorDefs}#recordScopedBlobCache`;
const DELEGATED_RELEASE_PERMISSION = Object.freeze({
	collection: NSID.packageRelease,
	scope: `atproto repo:${NSID.packageRelease}?action=create blob:application/gzip blob:image/*`
});
/**
* NSIDs of record-shaped lexicons in this package (one row per NSID in the
* publisher's repo). Embedded objects (`profileExtension`, `releaseExtension`) and shared defs
* (`aggregator.defs`) are excluded — they don't address their own collection.
*
* Useful for consumers building OAuth `repo:` scopes or enumerating writable
* collections without hand-rolling a list that drifts from the lexicons.
*/
const RECORD_NSIDS = [
	NSID.packageProfile,
	NSID.packageRelease,
	NSID.publisherProfile,
	NSID.publisherVerification
];
/**
* NSIDs of query-shaped lexicons in this package (read-only XRPC methods on
* the aggregator). Procedures and shared defs are excluded.
*
* Useful for consumers building OAuth `rpc:` scopes or enumerating callable
* AppView endpoints.
*/
const QUERY_NSIDS = [
	NSID.aggregatorGetLatestRelease,
	NSID.aggregatorGetPackage,
	NSID.aggregatorListReleases,
	NSID.aggregatorResolvePackage,
	NSID.aggregatorSearchPackages,
	NSID.labelerGetAssessment,
	NSID.labelerGetCurrentAssessment,
	NSID.labelerGetPolicy,
	NSID.labelerListAssessments
];

//#endregion
//#region ../../node_modules/.pnpm/@atcute+multibase@1.2.0/node_modules/@atcute/multibase/dist/bases/base32-encode.js
const ALPHABET$1 = "abcdefghijklmnopqrstuvwxyz234567";
const _cc = (() => {
	const t = new Uint8Array(32);
	for (let i = 0; i < 32; i++) t[i] = ALPHABET$1.charCodeAt(i);
	return t;
})();
const _fromCharCode = String.fromCharCode;
/**
* encodes a Uint8Array to an unpadded RFC 4648 base32 (lowercase) string
* @param bytes source buffer
* @returns base32 encoded string
*/
const toBase32 = (bytes) => {
	const len = bytes.length;
	const full = len / 5 | 0;
	const rem = len - full * 5;
	const cc = _cc;
	let str = "";
	let ip = 0;
	const pairs = full / 2 | 0;
	for (let g = 0; g < pairs; g++) {
		const a0 = bytes[ip], a1 = bytes[ip + 1], a2 = bytes[ip + 2], a3 = bytes[ip + 3], a4 = bytes[ip + 4];
		const b0 = bytes[ip + 5], b1 = bytes[ip + 6], b2 = bytes[ip + 7], b3 = bytes[ip + 8], b4 = bytes[ip + 9];
		str += _fromCharCode(cc[a0 >>> 3], cc[(a0 << 2 | a1 >>> 6) & 31], cc[a1 >>> 1 & 31], cc[(a1 << 4 | a2 >>> 4) & 31], cc[(a2 << 1 | a3 >>> 7) & 31], cc[a3 >>> 2 & 31], cc[(a3 << 3 | a4 >>> 5) & 31], cc[a4 & 31], cc[b0 >>> 3], cc[(b0 << 2 | b1 >>> 6) & 31], cc[b1 >>> 1 & 31], cc[(b1 << 4 | b2 >>> 4) & 31], cc[(b2 << 1 | b3 >>> 7) & 31], cc[b3 >>> 2 & 31], cc[(b3 << 3 | b4 >>> 5) & 31], cc[b4 & 31]);
		ip += 10;
	}
	if (full & 1) {
		const b0 = bytes[ip], b1 = bytes[ip + 1], b2 = bytes[ip + 2], b3 = bytes[ip + 3], b4 = bytes[ip + 4];
		str += _fromCharCode(cc[b0 >>> 3], cc[(b0 << 2 | b1 >>> 6) & 31], cc[b1 >>> 1 & 31], cc[(b1 << 4 | b2 >>> 4) & 31], cc[(b2 << 1 | b3 >>> 7) & 31], cc[b3 >>> 2 & 31], cc[(b3 << 3 | b4 >>> 5) & 31], cc[b4 & 31]);
		ip += 5;
	}
	if (rem > 0) {
		let buffer = 0;
		let bits = 0;
		for (let i = ip; i < len; i++) {
			buffer = buffer << 8 | bytes[i];
			bits += 8;
		}
		while (bits >= 5) {
			bits -= 5;
			str += _fromCharCode(cc[buffer >>> bits & 31]);
		}
		if (bits > 0) str += _fromCharCode(cc[buffer << 5 - bits & 31]);
	}
	return str;
};

//#endregion
//#region ../../node_modules/.pnpm/@atcute+multibase@1.2.0/node_modules/@atcute/multibase/dist/bases/base32.js
const ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
const _decodeLut = (() => {
	const t = new Uint8Array(128).fill(255);
	for (let i = 0; i < 32; i++) t[ALPHABET.charCodeAt(i)] = i;
	return t;
})();
/**
* decodes an unpadded RFC 4648 base32 (lowercase) string to a Uint8Array
* @param str base32 encoded string
* @returns decoded buffer
* @throws {SyntaxError} on invalid characters or malformed trailing bits
*/
const fromBase32 = (str) => {
	const end = str.length;
	const bytes = allocUnsafe(end * 5 / 8 | 0);
	let written = 0;
	let i = 0;
	const fullGroups = end - end % 8;
	for (; i < fullGroups; i += 8) {
		const c0 = _decodeLut[str.charCodeAt(i)];
		const c1 = _decodeLut[str.charCodeAt(i + 1)];
		const c2 = _decodeLut[str.charCodeAt(i + 2)];
		const c3 = _decodeLut[str.charCodeAt(i + 3)];
		const c4 = _decodeLut[str.charCodeAt(i + 4)];
		const c5 = _decodeLut[str.charCodeAt(i + 5)];
		const c6 = _decodeLut[str.charCodeAt(i + 6)];
		const c7 = _decodeLut[str.charCodeAt(i + 7)];
		if ((c0 | c1 | c2 | c3 | c4 | c5 | c6 | c7) & 224) throw new SyntaxError(`invalid base string`);
		bytes[written] = c0 << 3 | c1 >>> 2;
		bytes[written + 1] = (c1 << 6 | c2 << 1 | c3 >>> 4) & 255;
		bytes[written + 2] = (c3 << 4 | c4 >>> 1) & 255;
		bytes[written + 3] = (c4 << 7 | c5 << 2 | c6 >>> 3) & 255;
		bytes[written + 4] = (c6 << 5 | c7) & 255;
		written += 5;
	}
	if (i < end) {
		let bits = 0;
		let buffer = 0;
		for (; i < end; ++i) {
			const value = _decodeLut[str.charCodeAt(i)];
			if (value & 224) throw new SyntaxError(`invalid base string`);
			buffer = buffer << 5 | value;
			bits += 5;
			if (bits >= 8) {
				bits -= 8;
				bytes[written++] = 255 & buffer >> bits;
			}
		}
		if (bits >= 5 || (255 & buffer << 8 - bits) !== 0) throw new SyntaxError(`unexpected end of data`);
	}
	return bytes;
};

//#endregion
//#region ../../packages/registry-client/dist/types-BKvoAsmc.js
const SOURCE_ARTIFACT_KEYS = new Set([
	"$type",
	"package",
	"icon",
	"banner",
	"screenshots"
]);
const IMAGE_CONTENT_TYPES = new Set([
	"image/jpeg",
	"image/png",
	"image/webp"
]);
function isRecord$1(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isHttpsUrl(value) {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === "";
	} catch {
		return false;
	}
}
function isCanonicalSha256Multihash(value) {
	if (typeof value !== "string" || !value.startsWith("b")) return false;
	try {
		const bytes = fromBase32(value.slice(1));
		return bytes.length === 34 && bytes[0] === 18 && bytes[1] === 32 && `b${toBase32(bytes)}` === value;
	} catch {
		return false;
	}
}
function validSourceArtifact(value, image) {
	if (!isRecord$1(value) || Object.hasOwn(value, "blob") || Object.hasOwn(value, "requiresAuth") || !isHttpsUrl(value["url"]) || !isCanonicalSha256Multihash(value["checksum"])) return false;
	const contentType = value["contentType"];
	return contentType === void 0 ? true : image ? typeof contentType === "string" && IMAGE_CONTENT_TYPES.has(contentType) : contentType === "application/gzip";
}
function validSourceArtifacts(value) {
	if (!isRecord$1(value) || Object.keys(value).some((key) => !SOURCE_ARTIFACT_KEYS.has(key)) || !validSourceArtifact(value["package"], false) || value["icon"] !== void 0 && !validSourceArtifact(value["icon"], true) || value["banner"] !== void 0 && !validSourceArtifact(value["banner"], true)) return false;
	const screenshots = value["screenshots"];
	return screenshots === void 0 || Array.isArray(screenshots) && screenshots.every((artifact) => validSourceArtifact(artifact, true));
}
function isDelegatedReleaseSourceRecord(release, envelope) {
	if (Object.hasOwn(release, "auth") || !validSourceArtifacts(release.artifacts) || envelope !== void 0 && (release.package !== envelope.packageSlug || release.version !== envelope.version) || !isRecord$1(release.extensions)) return false;
	const extension = /* @__PURE__ */ safeParse$2(releaseExtension_exports.mainSchema, release.extensions[NSID.packageReleaseExtension]);
	return extension.ok && extension.value.provenance !== void 0 && isHttpsUrl(extension.value.provenance.url) && isCanonicalSha256Multihash(extension.value.provenance.checksum);
}
function parseDelegatedReleaseSourceRecord(value, envelope) {
	const release = /* @__PURE__ */ safeParse$2(release_exports.mainSchema, value);
	return release.ok && isDelegatedReleaseSourceRecord(release.value, envelope) ? release.value : null;
}
const TERMINAL_RELEASE_INTENT_STATES = new Set([
	"published",
	"invalid",
	"rejected",
	"cancelled",
	"expired",
	"failed",
	"conflict"
]);

//#endregion
//#region ../../packages/registry-client/dist/release-service/index.js
const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,127}$/;
const CID_PATTERN = /^[A-Za-z0-9]+$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{15,127}$/;
const CHECKSUM_PATTERN = /^b[a-z2-7]{10,255}$/;
const SCREENSHOT_SLOT_PATTERN = /^screenshots\[([0-7])\]$/;
const DIGITS_PATTERN = /^[0-9]+$/;
const POSITIVE_INTEGER_PATTERN$1 = /^[1-9][0-9]*$/;
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const WORKFLOW_CONNECTION_INVITATION_PATTERN = /^ewci1_[A-Za-z0-9_-]{43}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const API_ERROR_CODES = {
	ACCESS_DENIED: true,
	ACCESS_AUTH_INVALID: true,
	ACCESS_AUTH_REQUIRED: true,
	APPROVAL_INVALID: true,
	APPROVER_SESSION_INVALID: true,
	APPROVER_SUSPENDED: true,
	ARCHIVE_OPERATION_FAILED: true,
	AUTH_INVALID: true,
	CONFIGURATION_ERROR: true,
	CREDENTIAL_LIMIT_REACHED: true,
	CREDENTIAL_NOT_FOUND: true,
	CREDENTIAL_REVOKED: true,
	CSRF_INVALID: true,
	DELEGATION_REQUIRED: true,
	ENCRYPTION_OPERATION_FAILED: true,
	IDEMPOTENCY_KEY_INVALID: true,
	IDEMPOTENCY_CONFLICT: true,
	INTERNAL_ERROR: true,
	INVALID_REQUEST: true,
	INTENT_NOT_APPROVABLE: true,
	INTENT_NOT_CANCELLABLE: true,
	METHOD_NOT_ALLOWED: true,
	NOT_FOUND: true,
	OAUTH_AUTHORIZATION_FAILED: true,
	OAUTH_CALLBACK_INVALID: true,
	PACKAGE_PROFILE_REQUIRED: true,
	PROFILE_CHANGED: true,
	PROFILE_FETCH_FAILED: true,
	PUBLISHER_SESSION_INVALID: true,
	PUBLISHER_SUSPENDED: true,
	RELEASE_EXISTS: true,
	RESTORE_OPERATION_FAILED: true,
	SERVICE_PAUSED: true,
	SERVICE_UNAVAILABLE: true,
	VERSION_RESERVED: true,
	WORKFLOW_UNAVAILABLE: true,
	WORKFLOW_CONNECTION_CONFLICT: true,
	WORKFLOW_CONNECTION_EXPIRED: true,
	WORKFLOW_CONNECTION_INVITATION_EXPIRED: true,
	WORKFLOW_CONNECTION_INVITATION_INVALID: true,
	WORKFLOW_CONNECTION_INVITATION_LIMIT_REACHED: true,
	WORKFLOW_CONNECTION_INVITATION_REQUIRED: true,
	WORKFLOW_CONNECTION_LIMIT_REACHED: true,
	WORKFLOW_CONNECTION_NOT_FOUND: true,
	WORKLOAD_NOT_ALLOWED: true,
	WORKLOAD_RATE_LIMITED: true
};
const RETRYABLE_ERROR_CODES = new Set([
	"CONFIGURATION_ERROR",
	"INTERNAL_ERROR",
	"NETWORK_ERROR",
	"PROFILE_FETCH_FAILED",
	"PUBLISHER_SUSPENDED",
	"SERVICE_PAUSED",
	"SERVICE_UNAVAILABLE",
	"WORKFLOW_UNAVAILABLE",
	"WORKLOAD_RATE_LIMITED"
]);
const INTENT_STATES = {
	received: true,
	verifying: true,
	verified: true,
	awaiting_approval: true,
	ready: true,
	publishing: true,
	reconciling: true,
	published: true,
	invalid: true,
	rejected: true,
	cancelled: true,
	expired: true,
	failed: true,
	conflict: true
};
var ReleaseServiceError = class extends Error {
	code;
	status;
	requestId;
	retryable;
	retryAfterMs;
	constructor(input) {
		super(input.message);
		this.name = "ReleaseServiceError";
		this.code = input.code;
		this.status = input.status ?? 0;
		this.requestId = input.requestId ?? null;
		this.retryable = RETRYABLE_ERROR_CODES.has(input.code);
		this.retryAfterMs = input.retryAfterMs ?? null;
	}
};
function isRecord(value) {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isIntentState(value) {
	return typeof value === "string" && Object.hasOwn(INTENT_STATES, value);
}
function isApiErrorCode(value) {
	return typeof value === "string" && Object.hasOwn(API_ERROR_CODES, value);
}
function serviceOrigin(value) {
	try {
		const url = new URL(value);
		const loopback = url.protocol === "http:" && (url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]");
		if (url.protocol !== "https:" && !loopback || url.username !== "" || url.password !== "" || url.pathname !== "/" || url.search !== "" || url.hash !== "" || url.origin !== value) throw new Error("invalid origin");
		return url.origin;
	} catch {
		throw new ReleaseServiceError({
			code: "CLIENT_RESPONSE_INVALID",
			message: "Release service URL must be an HTTPS origin or a loopback development origin"
		});
	}
}
function requireIdempotencyKey(value) {
	if (!IDEMPOTENCY_KEY_PATTERN.test(value)) throw new ReleaseServiceError({
		code: "IDEMPOTENCY_KEY_INVALID",
		message: "Idempotency key is invalid"
	});
	return value;
}
function stringValue(value, key) {
	const item = value[key];
	return typeof item === "string" ? item : null;
}
function nullableString(value, key) {
	const item = value[key];
	return item === null || typeof item === "string" ? item : void 0;
}
function safeInteger(value, key) {
	const item = value[key];
	return Number.isSafeInteger(item) ? Number(item) : null;
}
function nullableSafeInteger(value, key) {
	const item = value[key];
	return item === null ? null : Number.isSafeInteger(item) ? Number(item) : void 0;
}
function parseIntentResult(value) {
	if (value === null) return null;
	if (!isRecord(value)) return void 0;
	const uri = stringValue(value, "uri");
	const cid = stringValue(value, "cid");
	return uri && cid ? {
		uri,
		cid
	} : void 0;
}
function parseIntent(value, serviceUrl) {
	if (!isRecord(value)) throw invalidResponse();
	const id = stringValue(value, "id");
	const publisherDid = stringValue(value, "publisherDid");
	const packageSlug = stringValue(value, "packageSlug");
	const version = stringValue(value, "version");
	const state = value["state"];
	const stateGeneration = safeInteger(value, "stateGeneration");
	const reasonCode = nullableString(value, "reasonCode");
	const workflowId = nullableString(value, "workflowId");
	const expiresAt = safeInteger(value, "expiresAt");
	const createdAt = safeInteger(value, "createdAt");
	const updatedAt = safeInteger(value, "updatedAt");
	const result = parseIntentResult(value["result"]);
	const approvalUrl = nullableString(value, "approvalUrl");
	if (!id || !ULID_PATTERN.test(id) || !publisherDid || !DID_PATTERN.test(publisherDid) || !packageSlug || !PACKAGE_SLUG_PATTERN.test(packageSlug) || !version || !VERSION_PATTERN.test(version) || !isIntentState(state) || stateGeneration === null || stateGeneration < 1 || reasonCode === void 0 || workflowId === void 0 || expiresAt === null || createdAt === null || updatedAt === null || result === void 0 || approvalUrl === void 0 || workflowId !== null && !ULID_PATTERN.test(workflowId) || createdAt > updatedAt || result !== null && (result.uri !== `at://${publisherDid}/com.emdashcms.experimental.package.release/${packageSlug}:${version}` || !CID_PATTERN.test(result.cid))) throw invalidResponse();
	if (approvalUrl !== null && serviceUrl) {
		let parsedApproval;
		try {
			parsedApproval = new URL(approvalUrl);
		} catch {
			throw invalidResponse();
		}
		if (parsedApproval.origin !== serviceUrl) throw invalidResponse();
	}
	return {
		id,
		publisherDid,
		packageSlug,
		version,
		state,
		stateGeneration,
		reasonCode,
		workflowId,
		expiresAt,
		createdAt,
		updatedAt,
		result,
		approvalUrl
	};
}
function parseDryRunIntent(value) {
	if (!isRecord(value)) throw invalidResponse();
	const publisherDid = stringValue(value, "publisherDid");
	const packageSlug = stringValue(value, "packageSlug");
	const version = stringValue(value, "version");
	const workloadPolicyVersion = safeInteger(value, "workloadPolicyVersion");
	const workloadIdentityDigest = stringValue(value, "workloadIdentityDigest");
	const requestDigest = stringValue(value, "requestDigest");
	if (value["allowed"] !== true || !publisherDid || !DID_PATTERN.test(publisherDid) || !packageSlug || !PACKAGE_SLUG_PATTERN.test(packageSlug) || !version || !VERSION_PATTERN.test(version) || workloadPolicyVersion === null || workloadPolicyVersion < 1 || !workloadIdentityDigest || !DIGEST_PATTERN.test(workloadIdentityDigest) || !requestDigest || !DIGEST_PATTERN.test(requestDigest)) throw invalidResponse();
	return {
		allowed: true,
		publisherDid,
		packageSlug,
		version,
		workloadPolicyVersion,
		workloadIdentityDigest,
		requestDigest
	};
}
function parseStringArray(value) {
	return Array.isArray(value) && value.every((item) => typeof item === "string") ? [...value] : null;
}
function parsePolicy(value) {
	if (!isRecord(value)) throw invalidResponse();
	const packageSlug = stringValue(value, "packageSlug");
	const repository = stringValue(value, "repository");
	const repositoryId = stringValue(value, "repositoryId");
	const repositoryOwnerId = stringValue(value, "repositoryOwnerId");
	const workflowRef = stringValue(value, "workflowRef");
	const allowedRefs = parseStringArray(value["allowedRefs"]);
	const allowedEnvironments = parseStringArray(value["allowedEnvironments"]);
	const stateVersion = safeInteger(value, "stateVersion");
	const authorizedBy = stringValue(value, "authorizedBy");
	const createdAt = safeInteger(value, "createdAt");
	const updatedAt = safeInteger(value, "updatedAt");
	if (!packageSlug || !repository || !repositoryId || !repositoryOwnerId || !workflowRef || !allowedRefs || !allowedEnvironments || typeof value["active"] !== "boolean" || stateVersion === null || !authorizedBy || createdAt === null || updatedAt === null) throw invalidResponse();
	return {
		packageSlug,
		repository,
		repositoryId,
		repositoryOwnerId,
		workflowRef,
		allowedRefs,
		allowedEnvironments,
		active: value["active"],
		stateVersion,
		authorizedBy,
		createdAt,
		updatedAt
	};
}
function parseWorkflowConnectionClaim(value) {
	if (!isRecord(value)) throw invalidResponse();
	const repository = stringValue(value, "repository");
	const repositoryId = stringValue(value, "repositoryId");
	const repositoryOwner = stringValue(value, "repositoryOwner");
	const repositoryOwnerId = stringValue(value, "repositoryOwnerId");
	const repositoryVisibility = value["repositoryVisibility"];
	const workflowRef = stringValue(value, "workflowRef");
	const ref = stringValue(value, "ref");
	const environment = nullableString(value, "environment");
	if (!repository || !repositoryId || !POSITIVE_INTEGER_PATTERN$1.test(repositoryId) || !repositoryOwner || !repositoryOwnerId || !POSITIVE_INTEGER_PATTERN$1.test(repositoryOwnerId) || repositoryVisibility !== "public" && repositoryVisibility !== "private" && repositoryVisibility !== "internal" || !workflowRef || !ref || environment === void 0) throw invalidResponse();
	return {
		repository,
		repositoryId,
		repositoryOwner,
		repositoryOwnerId,
		repositoryVisibility,
		workflowRef,
		ref,
		environment
	};
}
function parseWorkflowConnectionRequest(value) {
	if (!isRecord(value)) throw invalidResponse();
	const id = stringValue(value, "id");
	const packageSlug = stringValue(value, "packageSlug");
	const state = value["state"];
	const refScope = value["refScope"];
	const expiresAt = safeInteger(value, "expiresAt");
	const createdAt = safeInteger(value, "createdAt");
	const confirmedAt = nullableSafeInteger(value, "confirmedAt");
	if (!id || !ULID_PATTERN.test(id) || !packageSlug || !PACKAGE_SLUG_PATTERN.test(packageSlug) || state !== "pending" && state !== "confirmed" && state !== "expired" || refScope !== null && refScope !== "current_ref" && refScope !== "version_tags" || expiresAt === null || createdAt === null || confirmedAt === void 0 || createdAt > expiresAt) throw invalidResponse();
	const claim = parseWorkflowConnectionClaim(value["claim"]);
	if (state === "pending" && (refScope !== null || confirmedAt !== null) || state === "confirmed" && (refScope === null || confirmedAt === null)) throw invalidResponse();
	return {
		id,
		packageSlug,
		state,
		claim,
		refScope,
		expiresAt,
		createdAt,
		confirmedAt
	};
}
function isReleaseArtifactSlot(value) {
	return value === "package" || value === "icon" || value === "banner" || value === "provenance" || typeof value === "string" && SCREENSHOT_SLOT_PATTERN.test(value);
}
function artifactContentTypeValid(slot, contentType) {
	if (slot === "package") return contentType === "application/gzip";
	if (slot === "provenance") return contentType === "application/json";
	return contentType === "image/png" || contentType === "image/jpeg" || contentType === "image/webp";
}
function stagedArtifactPath(slot, checksum) {
	if (slot === "provenance") return `/v1/provenance/${checksum}`;
	return `/v1/staged-artifacts/${slot.startsWith("screenshots[") ? slot.replaceAll("[", "-").replaceAll("]", "") : slot}/${checksum}`;
}
function parseDelegation(value) {
	if (value === null) return null;
	if (!isRecord(value)) throw invalidResponse();
	const releaseNsid = stringValue(value, "releaseNsid");
	const scope = stringValue(value, "scope");
	const issuer = nullableString(value, "issuer");
	const pdsUrl = nullableString(value, "pdsUrl");
	const expiresAt = value["expiresAt"];
	const refreshBefore = value["refreshBefore"];
	const status = value["status"];
	const stateVersion = safeInteger(value, "stateVersion");
	if (!releaseNsid || !scope || issuer === void 0 || pdsUrl === void 0 || expiresAt !== null && !Number.isSafeInteger(expiresAt) || refreshBefore !== null && !Number.isSafeInteger(refreshBefore) || status !== "active" && status !== "revoked" && status !== "reauthorization_required" || stateVersion === null) throw invalidResponse();
	return {
		releaseNsid,
		scope,
		issuer,
		pdsUrl,
		expiresAt: expiresAt === null ? null : Number(expiresAt),
		refreshBefore: refreshBefore === null ? null : Number(refreshBefore),
		status,
		stateVersion
	};
}
function parsePublisher(value) {
	if (!isRecord(value)) throw invalidResponse();
	const did = stringValue(value, "did");
	const handleValue = value["handle"];
	const handle = typeof handleValue === "string" ? handleValue : null;
	const delegation = parseDelegation(value["delegation"]);
	const sessionExpiresAt = value["sessionExpiresAt"];
	if (!did || !DID_PATTERN.test(did) || handleValue !== void 0 && handleValue !== null && handle === null || sessionExpiresAt !== void 0 && !Number.isSafeInteger(sessionExpiresAt)) throw invalidResponse();
	return {
		did,
		handle,
		delegation,
		...sessionExpiresAt === void 0 ? {} : { sessionExpiresAt: Number(sessionExpiresAt) }
	};
}
function parsePublisherAuditEvent(value) {
	if (!isRecord(value)) throw invalidResponse();
	const sequence = safeInteger(value, "sequence");
	const eventType = stringValue(value, "eventType");
	const actorRealm = value["actorRealm"];
	const actorIdentity = stringValue(value, "actorIdentity");
	const actorHandleValue = value["actorHandle"];
	const actorHandle = typeof actorHandleValue === "string" ? actorHandleValue : null;
	const subject = stringValue(value, "subject");
	const reasonCode = nullableString(value, "reasonCode");
	const createdAt = safeInteger(value, "createdAt");
	if (sequence === null || sequence < 1 || !eventType || actorRealm !== "access" && actorRealm !== "approver" && actorRealm !== "oidc" && actorRealm !== "publisher" && actorRealm !== "system" || !actorIdentity || actorHandleValue !== void 0 && actorHandleValue !== null && actorHandle === null || !subject || reasonCode === void 0 || createdAt === null) throw invalidResponse();
	return {
		sequence,
		eventType,
		actorRealm,
		actorIdentity,
		actorHandle,
		subject,
		reasonCode,
		createdAt
	};
}
function parsePublisherApproverStatus(value) {
	if (!isRecord(value)) throw invalidResponse();
	const did = stringValue(value, "did");
	const handleValue = value["handle"];
	const handle = typeof handleValue === "string" ? handleValue : null;
	const status = value["status"];
	if (!did || !DID_PATTERN.test(did) || handleValue !== void 0 && handleValue !== null && handle === null || status !== "enrolled" && status !== "not_enrolled" && status !== "revoked") throw invalidResponse();
	return {
		did,
		handle,
		status
	};
}
function invalidResponse(requestId = null) {
	return new ReleaseServiceError({
		code: "CLIENT_RESPONSE_INVALID",
		message: "Release service returned an invalid response",
		status: 502,
		requestId
	});
}
function retryAfterMs(response) {
	const value = response.headers.get("retry-after");
	if (!value) return null;
	if (DIGITS_PATTERN.test(value)) return Number(value) * 1e3;
	const date = Date.parse(value);
	return Number.isFinite(date) ? Math.max(0, date - Date.now()) : null;
}
function parseErrorPayload(value, response) {
	if (!isRecord(value) || !isRecord(value["error"])) throw invalidResponse();
	const code = stringValue(value["error"], "code");
	const message = stringValue(value["error"], "message");
	const requestId = nullableString(value, "requestId");
	if (!isApiErrorCode(code) || !message || requestId === void 0) throw invalidResponse(response.headers.get("x-request-id"));
	return {
		code,
		message,
		requestId
	};
}
async function responseJson(response) {
	if (response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !== "application/json") throw invalidResponse(response.headers.get("x-request-id"));
	try {
		return await response.json();
	} catch {
		throw invalidResponse(response.headers.get("x-request-id"));
	}
}
async function sleep(ms, signal) {
	if (signal?.aborted) throw signal.reason;
	await new Promise((resolve, reject) => {
		const complete = () => {
			signal?.removeEventListener("abort", abort);
			resolve();
		};
		const timer = setTimeout(complete, ms);
		const abort = () => {
			clearTimeout(timer);
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
	});
}
var BaseReleaseServiceClient = class {
	serviceUrl;
	fetch;
	constructor(options) {
		this.serviceUrl = serviceOrigin(options.serviceUrl);
		this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
	}
	async call(path, init, parse) {
		let response;
		try {
			response = await this.fetch(new URL(path, this.serviceUrl), init);
		} catch (error) {
			if (error instanceof DOMException && error.name === "AbortError") throw error;
			throw new ReleaseServiceError({
				code: "NETWORK_ERROR",
				message: "Release service request failed"
			});
		}
		const payload = await responseJson(response);
		if (!response.ok) throw new ReleaseServiceError({
			...parseErrorPayload(payload, response),
			status: response.status,
			retryAfterMs: retryAfterMs(response)
		});
		if (!isRecord(payload) || !("data" in payload)) throw invalidResponse(response.headers.get("x-request-id"));
		return parse(payload["data"]);
	}
};
var ReleaseServiceClient = class extends BaseReleaseServiceClient {
	#workloadToken;
	#csrfToken;
	constructor(options) {
		super(options);
		this.#workloadToken = options.workloadToken;
		this.#csrfToken = options.csrfToken;
	}
	async #token() {
		const token = typeof this.#workloadToken === "function" ? await this.#workloadToken() : this.#workloadToken;
		if (!token || token.length > 16 * 1024 || token.includes(" ")) throw new ReleaseServiceError({
			code: "AUTH_INVALID",
			message: "Workload token is unavailable"
		});
		return token;
	}
	async #csrf() {
		const token = typeof this.#csrfToken === "function" ? await this.#csrfToken() : this.#csrfToken;
		if (!token || !CSRF_TOKEN_PATTERN.test(token)) throw new ReleaseServiceError({
			code: "CSRF_INVALID",
			message: "Publisher CSRF token is unavailable"
		});
		return token;
	}
	async #workloadHeaders(idempotencyKey) {
		const headers = new Headers({ authorization: `Bearer ${await this.#token()}` });
		if (idempotencyKey) headers.set("idempotency-key", requireIdempotencyKey(idempotencyKey));
		return headers;
	}
	async #publisherMutationHeaders(idempotencyKey) {
		return new Headers({
			"content-type": "application/json",
			"idempotency-key": requireIdempotencyKey(idempotencyKey),
			"x-emdash-request": "1",
			"x-emdash-csrf": await this.#csrf()
		});
	}
	async submitIntent(input, options) {
		const release = parseDelegatedReleaseSourceRecord(input.release, {
			packageSlug: input.packageSlug,
			version: input.version
		});
		if (!release) throw new ReleaseServiceError({
			code: "INVALID_REQUEST",
			message: "Delegated release source record is invalid"
		});
		const headers = await this.#workloadHeaders(options.idempotencyKey);
		headers.set("content-type", "application/json");
		return await this.call("/v1/release-intents", {
			method: "POST",
			headers,
			body: JSON.stringify({
				...input,
				release
			}),
			signal: options.signal
		}, (value) => {
			if (!isRecord(value) || typeof value["replayed"] !== "boolean") throw invalidResponse();
			return {
				intent: parseIntent(value["intent"], this.serviceUrl),
				replayed: value["replayed"]
			};
		});
	}
	async uploadReleaseArtifact(input, options) {
		if (!DID_PATTERN.test(input.publisherDid) || !PACKAGE_SLUG_PATTERN.test(input.packageSlug) || !VERSION_PATTERN.test(input.version) || !isReleaseArtifactSlot(input.slot) || !CHECKSUM_PATTERN.test(input.checksum) || !artifactContentTypeValid(input.slot, input.contentType) || !(input.bytes instanceof Uint8Array) || input.bytes.byteLength < 1) throw new ReleaseServiceError({
			code: "INVALID_REQUEST",
			message: "Release artifact upload is invalid"
		});
		const headers = await this.#workloadHeaders(options.idempotencyKey);
		headers.set("content-length", String(input.bytes.byteLength));
		headers.set("content-type", input.contentType);
		headers.set("x-emdash-publisher-did", input.publisherDid);
		headers.set("x-emdash-package", input.packageSlug);
		headers.set("x-emdash-version", input.version);
		headers.set("x-emdash-artifact-slot", input.slot);
		headers.set("x-emdash-checksum", input.checksum);
		return await this.call("/v1/staged-artifacts", {
			method: "POST",
			headers,
			body: new Uint8Array(input.bytes),
			signal: options.signal
		}, (value) => {
			if (!isRecord(value) || !isRecord(value["artifact"]) || typeof value["replayed"] !== "boolean") throw invalidResponse();
			const artifact = value["artifact"];
			const slot = artifact["slot"];
			const checksum = stringValue(artifact, "checksum");
			const contentType = stringValue(artifact, "contentType");
			const size = safeInteger(artifact, "size");
			const sourceUrl = stringValue(artifact, "sourceUrl");
			if (!isReleaseArtifactSlot(slot) || slot !== input.slot || checksum !== input.checksum || contentType !== input.contentType || size !== input.bytes.byteLength || !sourceUrl) throw invalidResponse();
			let parsedSource;
			try {
				parsedSource = new URL(sourceUrl);
			} catch {
				throw invalidResponse();
			}
			if (parsedSource.origin !== this.serviceUrl || parsedSource.pathname !== stagedArtifactPath(input.slot, input.checksum) || parsedSource.search !== "" || parsedSource.hash !== "") throw invalidResponse();
			return {
				artifact: {
					slot,
					checksum,
					contentType,
					size,
					sourceUrl
				},
				replayed: value["replayed"]
			};
		});
	}
	async dryRunIntent(input, options = {}) {
		const release = parseDelegatedReleaseSourceRecord(input.release, {
			packageSlug: input.packageSlug,
			version: input.version
		});
		if (!release) throw new ReleaseServiceError({
			code: "INVALID_REQUEST",
			message: "Delegated release source record is invalid"
		});
		const headers = await this.#workloadHeaders();
		headers.set("content-type", "application/json");
		return await this.call("/v1/release-intents/dry-run", {
			method: "POST",
			headers,
			body: JSON.stringify({
				...input,
				release
			}),
			signal: options.signal
		}, parseDryRunIntent);
	}
	async getIntent(publisherDid, intentId, options = {}) {
		const headers = await this.#workloadHeaders();
		return await this.call(`/v1/release-intents/${encodeURIComponent(intentId)}?publisher=${encodeURIComponent(publisherDid)}`, {
			method: "GET",
			headers,
			signal: options.signal
		}, (value) => {
			if (!isRecord(value)) throw invalidResponse();
			return parseIntent(value["intent"], this.serviceUrl);
		});
	}
	async cancelIntent(publisherDid, intentId, options) {
		const headers = await this.#workloadHeaders(options.idempotencyKey);
		headers.set("content-type", "application/json");
		return await this.call(`/v1/release-intents/${encodeURIComponent(intentId)}/cancel?publisher=${encodeURIComponent(publisherDid)}`, {
			method: "POST",
			headers,
			body: "{}",
			signal: options.signal
		}, (value) => {
			if (!isRecord(value)) throw invalidResponse();
			return parseIntent(value["intent"], this.serviceUrl);
		});
	}
	async waitForIntent(publisherDid, intentId, options = {}) {
		const pollIntervalMs = options.pollIntervalMs ?? 1e3;
		const maxWaitMs = options.maxWaitMs ?? 15 * 6e4;
		if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || !Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1) throw new ReleaseServiceError({
			code: "INVALID_REQUEST",
			message: "Polling options are invalid"
		});
		const deadline = Date.now() + maxWaitMs;
		for (;;) {
			const intent = await this.getIntent(publisherDid, intentId, { signal: options.signal });
			await options.onUpdate?.(intent);
			if (TERMINAL_RELEASE_INTENT_STATES.has(intent.state) || (options.stopOnApproval ?? true) && intent.state === "awaiting_approval") return intent;
			if (Date.now() >= deadline) throw new ReleaseServiceError({
				code: "POLL_TIMEOUT",
				message: "Timed out waiting for release intent"
			});
			await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), options.signal);
		}
	}
	async getPublisher(options = {}) {
		return await this.call("/v1/publisher", {
			method: "GET",
			credentials: "include",
			signal: options.signal
		}, (value) => {
			if (!isRecord(value)) throw invalidResponse();
			return parsePublisher(value["publisher"]);
		});
	}
	async revokeDelegation(options) {
		return await this.call("/v1/publisher/delegation", {
			method: "DELETE",
			credentials: "include",
			headers: await this.#publisherMutationHeaders(options.idempotencyKey),
			body: "{}",
			signal: options.signal
		}, (value) => {
			if (!isRecord(value)) throw invalidResponse();
			return parsePublisher(value["publisher"]);
		});
	}
	async requestWorkflowConnection(input, options) {
		if (!DID_PATTERN.test(input.publisherDid) || !PACKAGE_SLUG_PATTERN.test(input.packageSlug) || input.invitationToken !== void 0 && !WORKFLOW_CONNECTION_INVITATION_PATTERN.test(input.invitationToken)) throw invalidResponse();
		const headers = await this.#workloadHeaders(options.idempotencyKey);
		headers.set("content-type", "application/json");
		return await this.call("/v1/workflow-connections", {
			method: "POST",
			headers,
			body: JSON.stringify(input),
			signal: options.signal
		}, (value) => {
			if (!isRecord(value)) throw invalidResponse();
			if (value["status"] === "connected") return {
				status: "connected",
				policy: parsePolicy(value["policy"])
			};
			if (value["status"] !== "pending" || typeof value["replayed"] !== "boolean") throw invalidResponse();
			const request = parseWorkflowConnectionRequest(value["request"]);
			const approvalUrl = stringValue(value, "approvalUrl");
			if (!approvalUrl) throw invalidResponse();
			let parsedApproval;
			try {
				parsedApproval = new URL(approvalUrl);
			} catch {
				throw invalidResponse();
			}
			if (parsedApproval.origin !== this.serviceUrl || parsedApproval.pathname !== "/publisher" || parsedApproval.searchParams.get("connection") !== request.id) throw invalidResponse();
			return {
				status: "pending",
				request,
				approvalUrl,
				replayed: value["replayed"]
			};
		});
	}
	async createWorkflowConnectionInvitation(packageSlug, options) {
		if (!PACKAGE_SLUG_PATTERN.test(packageSlug)) throw invalidResponse();
		return await this.call("/v1/publisher/workflow-connection-invitations", {
			method: "POST",
			credentials: "include",
			headers: await this.#publisherMutationHeaders(options.idempotencyKey),
			body: JSON.stringify({ packageSlug }),
			signal: options.signal
		}, (value) => {
			if (!isRecord(value)) throw invalidResponse();
			const invitationToken = stringValue(value, "invitationToken");
			const returnedPackageSlug = stringValue(value, "packageSlug");
			const expiresAt = safeInteger(value, "expiresAt");
			if (!invitationToken || !WORKFLOW_CONNECTION_INVITATION_PATTERN.test(invitationToken) || returnedPackageSlug !== packageSlug || expiresAt === null) throw invalidResponse();
			return {
				invitationToken,
				packageSlug: returnedPackageSlug,
				expiresAt
			};
		});
	}
	async waitForWorkflowConnection(input, options) {
		const pollIntervalMs = options.pollIntervalMs ?? 1e3;
		const maxWaitMs = options.maxWaitMs ?? 15 * 6e4;
		if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 0 || !Number.isSafeInteger(maxWaitMs) || maxWaitMs < 1) throw new ReleaseServiceError({
			code: "INVALID_REQUEST",
			message: "Polling options are invalid"
		});
		const deadline = Date.now() + maxWaitMs;
		for (;;) {
			const result = await this.requestWorkflowConnection(input, options);
			await options.onUpdate?.(result);
			if (result.status === "connected") return result.policy;
			if (Date.now() >= deadline) throw new ReleaseServiceError({
				code: "POLL_TIMEOUT",
				message: "Timed out waiting for workflow approval"
			});
			await sleep(Math.min(pollIntervalMs, Math.max(0, deadline - Date.now())), options.signal);
		}
	}
	async listWorkflowConnections(options = {}) {
		return await this.call("/v1/publisher/workflow-connections", {
			method: "GET",
			credentials: "include",
			signal: options.signal
		}, (value) => {
			if (!isRecord(value) || !Array.isArray(value["items"])) throw invalidResponse();
			return value["items"].map(parseWorkflowConnectionRequest);
		});
	}
	async confirmWorkflowConnection(requestId, refScope, options) {
		if (!ULID_PATTERN.test(requestId) || refScope !== "current_ref" && refScope !== "version_tags") throw invalidResponse();
		return await this.call(`/v1/publisher/workflow-connections/${encodeURIComponent(requestId)}/confirm`, {
			method: "POST",
			credentials: "include",
			headers: await this.#publisherMutationHeaders(options.idempotencyKey),
			body: JSON.stringify({ refScope }),
			signal: options.signal
		}, (value) => {
			if (!isRecord(value) || typeof value["replayed"] !== "boolean") throw invalidResponse();
			return {
				request: parseWorkflowConnectionRequest(value["request"]),
				policy: parsePolicy(value["policy"]),
				replayed: value["replayed"]
			};
		});
	}
	async rejectWorkflowConnection(requestId, options) {
		if (!ULID_PATTERN.test(requestId)) throw invalidResponse();
		await this.call(`/v1/publisher/workflow-connections/${encodeURIComponent(requestId)}`, {
			method: "DELETE",
			credentials: "include",
			headers: await this.#publisherMutationHeaders(options.idempotencyKey),
			body: "{}",
			signal: options.signal
		}, (value) => {
			if (!isRecord(value) || value["rejected"] !== true) throw invalidResponse();
		});
	}
	async listWorkloads(options = {}) {
		const url = new URL("/v1/publisher/workloads", this.serviceUrl);
		if (options.cursor) url.searchParams.set("cursor", options.cursor);
		if (options.limit !== void 0) url.searchParams.set("limit", String(options.limit));
		return await this.call(`${url.pathname}${url.search}`, {
			method: "GET",
			credentials: "include",
			signal: options.signal
		}, (value) => parsePage(value, parsePolicy));
	}
	async putWorkload(input, options) {
		return await this.call("/v1/publisher/workloads", {
			method: "POST",
			credentials: "include",
			headers: await this.#publisherMutationHeaders(options.idempotencyKey),
			body: JSON.stringify(input),
			signal: options.signal
		}, (value) => {
			if (!isRecord(value) || typeof value["replayed"] !== "boolean") throw invalidResponse();
			return {
				value: parsePolicy(value["policy"]),
				replayed: value["replayed"]
			};
		});
	}
	async disableWorkload(packageSlug, expectedVersion, options) {
		return await this.call(`/v1/publisher/workloads/${encodeURIComponent(packageSlug)}`, {
			method: "DELETE",
			credentials: "include",
			headers: await this.#publisherMutationHeaders(options.idempotencyKey),
			body: JSON.stringify({ expectedVersion }),
			signal: options.signal
		}, (value) => {
			if (!isRecord(value) || typeof value["replayed"] !== "boolean") throw invalidResponse();
			return {
				value: parsePolicy(value["policy"]),
				replayed: value["replayed"]
			};
		});
	}
	async listPublisherIntents(options = {}) {
		const url = new URL("/v1/publisher/intents", this.serviceUrl);
		if (options.cursor) url.searchParams.set("cursor", options.cursor);
		if (options.limit !== void 0) url.searchParams.set("limit", String(options.limit));
		return await this.call(`${url.pathname}${url.search}`, {
			method: "GET",
			credentials: "include",
			signal: options.signal
		}, (value) => parsePage(value, (item) => parseIntent(item, this.serviceUrl)));
	}
	async listPublisherAudit(options = {}) {
		const url = new URL("/v1/publisher/audit", this.serviceUrl);
		if (options.cursor) {
			if (!POSITIVE_INTEGER_PATTERN$1.test(options.cursor)) throw new ReleaseServiceError({
				code: "CLIENT_RESPONSE_INVALID",
				message: "Audit cursor is invalid"
			});
			url.searchParams.set("cursor", options.cursor);
		}
		if (options.limit !== void 0) {
			if (!Number.isSafeInteger(options.limit) || options.limit < 1 || options.limit > 100) throw new ReleaseServiceError({
				code: "CLIENT_RESPONSE_INVALID",
				message: "Audit limit is invalid"
			});
			url.searchParams.set("limit", String(options.limit));
		}
		return await this.call(`${url.pathname}${url.search}`, {
			method: "GET",
			credentials: "include",
			signal: options.signal
		}, (value) => parsePage(value, parsePublisherAuditEvent));
	}
	async getPublisherApproverStatus(packageSlug) {
		if (!PACKAGE_SLUG_PATTERN.test(packageSlug)) throw new ReleaseServiceError({
			code: "CLIENT_RESPONSE_INVALID",
			message: "Package slug is invalid"
		});
		return await this.call(`/v1/publisher/workloads/${encodeURIComponent(packageSlug)}/approvers`, {
			method: "GET",
			credentials: "include"
		}, (value) => {
			if (!isRecord(value) || !Array.isArray(value["items"])) throw invalidResponse();
			const returnedPackageSlug = stringValue(value, "packageSlug");
			const profileCid = stringValue(value, "profileCid");
			if (returnedPackageSlug !== packageSlug || !profileCid || !CID_PATTERN.test(profileCid)) throw invalidResponse();
			return {
				packageSlug: returnedPackageSlug,
				profileCid,
				items: value["items"].map(parsePublisherApproverStatus)
			};
		});
	}
};
function parsePage(value, parseItem) {
	if (!isRecord(value) || !Array.isArray(value["items"])) throw invalidResponse();
	const nextCursor = value["nextCursor"];
	if (nextCursor !== void 0 && typeof nextCursor !== "string") throw invalidResponse();
	return {
		items: value["items"].map(parseItem),
		...nextCursor ? { nextCursor } : {}
	};
}

//#endregion
//#region ../../node_modules/.pnpm/zod@4.4.1/node_modules/zod/v4/core/core.js
var _a$1;
function $constructor(name, initializer, params) {
	function init(inst, def) {
		if (!inst._zod) Object.defineProperty(inst, "_zod", {
			value: {
				def,
				constr: _,
				traits: /* @__PURE__ */ new Set()
			},
			enumerable: false
		});
		if (inst._zod.traits.has(name)) return;
		inst._zod.traits.add(name);
		initializer(inst, def);
		const proto = _.prototype;
		const keys = Object.keys(proto);
		for (let i = 0; i < keys.length; i++) {
			const k = keys[i];
			if (!(k in inst)) inst[k] = proto[k].bind(inst);
		}
	}
	const Parent = params?.Parent ?? Object;
	class Definition extends Parent {}
	Object.defineProperty(Definition, "name", { value: name });
	function _(def) {
		var _a;
		const inst = params?.Parent ? new Definition() : this;
		init(inst, def);
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		for (const fn of inst._zod.deferred) fn();
		return inst;
	}
	Object.defineProperty(_, "init", { value: init });
	Object.defineProperty(_, Symbol.hasInstance, { value: (inst) => {
		if (params?.Parent && inst instanceof params.Parent) return true;
		return inst?._zod?.traits?.has(name);
	} });
	Object.defineProperty(_, "name", { value: name });
	return _;
}
var $ZodAsyncError = class extends Error {
	constructor() {
		super(`Encountered Promise during synchronous parse. Use .parseAsync() instead.`);
	}
};
var $ZodEncodeError = class extends Error {
	constructor(name) {
		super(`Encountered unidirectional transform during encode: ${name}`);
		this.name = "ZodEncodeError";
	}
};
(_a$1 = globalThis).__zod_globalConfig ?? (_a$1.__zod_globalConfig = {});
const globalConfig = globalThis.__zod_globalConfig;
function config(newConfig) {
	if (newConfig) Object.assign(globalConfig, newConfig);
	return globalConfig;
}

//#endregion
//#region ../../node_modules/.pnpm/zod@4.4.1/node_modules/zod/v4/core/util.js
function getEnumValues(entries) {
	const numericValues = Object.values(entries).filter((v) => typeof v === "number");
	return Object.entries(entries).filter(([k, _]) => numericValues.indexOf(+k) === -1).map(([_, v]) => v);
}
function jsonStringifyReplacer(_, value) {
	if (typeof value === "bigint") return value.toString();
	return value;
}
function cached(getter) {
	return { get value() {
		{
			const value = getter();
			Object.defineProperty(this, "value", { value });
			return value;
		}
		throw new Error("cached value already set");
	} };
}
function nullish(input) {
	return input === null || input === void 0;
}
function cleanRegex(source) {
	const start = source.startsWith("^") ? 1 : 0;
	const end = source.endsWith("$") ? source.length - 1 : source.length;
	return source.slice(start, end);
}
function floatSafeRemainder(val, step) {
	const ratio = val / step;
	const roundedRatio = Math.round(ratio);
	const tolerance = Number.EPSILON * Math.max(Math.abs(ratio), 1);
	if (Math.abs(ratio - roundedRatio) < tolerance) return 0;
	return ratio - roundedRatio;
}
const EVALUATING = /* @__PURE__ */ Symbol("evaluating");
function defineLazy(object, key, getter) {
	let value = void 0;
	Object.defineProperty(object, key, {
		get() {
			if (value === EVALUATING) return;
			if (value === void 0) {
				value = EVALUATING;
				value = getter();
			}
			return value;
		},
		set(v) {
			Object.defineProperty(object, key, { value: v });
		},
		configurable: true
	});
}
function assignProp(target, prop, value) {
	Object.defineProperty(target, prop, {
		value,
		writable: true,
		enumerable: true,
		configurable: true
	});
}
function mergeDefs(...defs) {
	const mergedDescriptors = {};
	for (const def of defs) {
		const descriptors = Object.getOwnPropertyDescriptors(def);
		Object.assign(mergedDescriptors, descriptors);
	}
	return Object.defineProperties({}, mergedDescriptors);
}
function esc(str) {
	return JSON.stringify(str);
}
function slugify(input) {
	return input.toLowerCase().trim().replace(/[^\w\s-]/g, "").replace(/[\s_-]+/g, "-").replace(/^-+|-+$/g, "");
}
const captureStackTrace = "captureStackTrace" in Error ? Error.captureStackTrace : (..._args) => {};
function isObject(data) {
	return typeof data === "object" && data !== null && !Array.isArray(data);
}
const allowsEval = /* @__PURE__ */ cached(() => {
	if (globalConfig.jitless) return false;
	if (typeof navigator !== "undefined" && navigator?.userAgent?.includes("Cloudflare")) return false;
	try {
		new Function("");
		return true;
	} catch (_) {
		return false;
	}
});
function isPlainObject(o) {
	if (isObject(o) === false) return false;
	const ctor = o.constructor;
	if (ctor === void 0) return true;
	if (typeof ctor !== "function") return true;
	const prot = ctor.prototype;
	if (isObject(prot) === false) return false;
	if (Object.prototype.hasOwnProperty.call(prot, "isPrototypeOf") === false) return false;
	return true;
}
function shallowClone(o) {
	if (isPlainObject(o)) return { ...o };
	if (Array.isArray(o)) return [...o];
	if (o instanceof Map) return new Map(o);
	if (o instanceof Set) return new Set(o);
	return o;
}
const propertyKeyTypes = /* @__PURE__ */ new Set([
	"string",
	"number",
	"symbol"
]);
function escapeRegex(str) {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function clone(inst, def, params) {
	const cl = new inst._zod.constr(def ?? inst._zod.def);
	if (!def || params?.parent) cl._zod.parent = inst;
	return cl;
}
function normalizeParams(_params) {
	const params = _params;
	if (!params) return {};
	if (typeof params === "string") return { error: () => params };
	if (params?.message !== void 0) {
		if (params?.error !== void 0) throw new Error("Cannot specify both `message` and `error` params");
		params.error = params.message;
	}
	delete params.message;
	if (typeof params.error === "string") return {
		...params,
		error: () => params.error
	};
	return params;
}
function optionalKeys(shape) {
	return Object.keys(shape).filter((k) => {
		return shape[k]._zod.optin === "optional" && shape[k]._zod.optout === "optional";
	});
}
const NUMBER_FORMAT_RANGES = {
	safeint: [Number.MIN_SAFE_INTEGER, Number.MAX_SAFE_INTEGER],
	int32: [-2147483648, 2147483647],
	uint32: [0, 4294967295],
	float32: [-34028234663852886e22, 34028234663852886e22],
	float64: [-Number.MAX_VALUE, Number.MAX_VALUE]
};
function pick(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".pick() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const newShape = {};
			for (const key in mask) {
				if (!(key in currDef.shape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				newShape[key] = currDef.shape[key];
			}
			assignProp(this, "shape", newShape);
			return newShape;
		},
		checks: []
	}));
}
function omit(schema, mask) {
	const currDef = schema._zod.def;
	const checks = currDef.checks;
	if (checks && checks.length > 0) throw new Error(".omit() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const newShape = { ...schema._zod.def.shape };
			for (const key in mask) {
				if (!(key in currDef.shape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				delete newShape[key];
			}
			assignProp(this, "shape", newShape);
			return newShape;
		},
		checks: []
	}));
}
function extend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to extend: expected a plain object");
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) {
		const existingShape = schema._zod.def.shape;
		for (const key in shape) if (Object.getOwnPropertyDescriptor(existingShape, key) !== void 0) throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.");
	}
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const _shape = {
			...schema._zod.def.shape,
			...shape
		};
		assignProp(this, "shape", _shape);
		return _shape;
	} }));
}
function safeExtend(schema, shape) {
	if (!isPlainObject(shape)) throw new Error("Invalid input to safeExtend: expected a plain object");
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const _shape = {
			...schema._zod.def.shape,
			...shape
		};
		assignProp(this, "shape", _shape);
		return _shape;
	} }));
}
function merge(a, b) {
	if (a._zod.def.checks?.length) throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");
	return clone(a, mergeDefs(a._zod.def, {
		get shape() {
			const _shape = {
				...a._zod.def.shape,
				...b._zod.def.shape
			};
			assignProp(this, "shape", _shape);
			return _shape;
		},
		get catchall() {
			return b._zod.def.catchall;
		},
		checks: b._zod.def.checks ?? []
	}));
}
function partial(Class, schema, mask) {
	const checks = schema._zod.def.checks;
	if (checks && checks.length > 0) throw new Error(".partial() cannot be used on object schemas containing refinements");
	return clone(schema, mergeDefs(schema._zod.def, {
		get shape() {
			const oldShape = schema._zod.def.shape;
			const shape = { ...oldShape };
			if (mask) for (const key in mask) {
				if (!(key in oldShape)) throw new Error(`Unrecognized key: "${key}"`);
				if (!mask[key]) continue;
				shape[key] = Class ? new Class({
					type: "optional",
					innerType: oldShape[key]
				}) : oldShape[key];
			}
			else for (const key in oldShape) shape[key] = Class ? new Class({
				type: "optional",
				innerType: oldShape[key]
			}) : oldShape[key];
			assignProp(this, "shape", shape);
			return shape;
		},
		checks: []
	}));
}
function required(Class, schema, mask) {
	return clone(schema, mergeDefs(schema._zod.def, { get shape() {
		const oldShape = schema._zod.def.shape;
		const shape = { ...oldShape };
		if (mask) for (const key in mask) {
			if (!(key in shape)) throw new Error(`Unrecognized key: "${key}"`);
			if (!mask[key]) continue;
			shape[key] = new Class({
				type: "nonoptional",
				innerType: oldShape[key]
			});
		}
		else for (const key in oldShape) shape[key] = new Class({
			type: "nonoptional",
			innerType: oldShape[key]
		});
		assignProp(this, "shape", shape);
		return shape;
	} }));
}
function aborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue !== true) return true;
	return false;
}
function explicitlyAborted(x, startIndex = 0) {
	if (x.aborted === true) return true;
	for (let i = startIndex; i < x.issues.length; i++) if (x.issues[i]?.continue === false) return true;
	return false;
}
function prefixIssues(path, issues) {
	return issues.map((iss) => {
		var _a;
		(_a = iss).path ?? (_a.path = []);
		iss.path.unshift(path);
		return iss;
	});
}
function unwrapMessage(message) {
	return typeof message === "string" ? message : message?.message;
}
function finalizeIssue(iss, ctx, config) {
	const message = iss.message ? iss.message : unwrapMessage(iss.inst?._zod.def?.error?.(iss)) ?? unwrapMessage(ctx?.error?.(iss)) ?? unwrapMessage(config.customError?.(iss)) ?? unwrapMessage(config.localeError?.(iss)) ?? "Invalid input";
	const { inst: _inst, continue: _continue, input: _input, ...rest } = iss;
	rest.path ?? (rest.path = []);
	rest.message = message;
	if (ctx?.reportInput) rest.input = _input;
	return rest;
}
function getLengthableOrigin(input) {
	if (Array.isArray(input)) return "array";
	if (typeof input === "string") return "string";
	return "unknown";
}
function issue(...args) {
	const [iss, input, inst] = args;
	if (typeof iss === "string") return {
		message: iss,
		code: "custom",
		input,
		inst
	};
	return { ...iss };
}

//#endregion
//#region ../../node_modules/.pnpm/zod@4.4.1/node_modules/zod/v4/core/errors.js
const initializer$1 = (inst, def) => {
	inst.name = "$ZodError";
	Object.defineProperty(inst, "_zod", {
		value: inst._zod,
		enumerable: false
	});
	Object.defineProperty(inst, "issues", {
		value: def,
		enumerable: false
	});
	inst.message = JSON.stringify(def, jsonStringifyReplacer, 2);
	Object.defineProperty(inst, "toString", {
		value: () => inst.message,
		enumerable: false
	});
};
const $ZodError = $constructor("$ZodError", initializer$1);
const $ZodRealError = $constructor("$ZodError", initializer$1, { Parent: Error });
function flattenError(error, mapper = (issue) => issue.message) {
	const fieldErrors = {};
	const formErrors = [];
	for (const sub of error.issues) if (sub.path.length > 0) {
		fieldErrors[sub.path[0]] = fieldErrors[sub.path[0]] || [];
		fieldErrors[sub.path[0]].push(mapper(sub));
	} else formErrors.push(mapper(sub));
	return {
		formErrors,
		fieldErrors
	};
}
function formatError(error, mapper = (issue) => issue.message) {
	const fieldErrors = { _errors: [] };
	const processError = (error, path = []) => {
		for (const issue of error.issues) if (issue.code === "invalid_union" && issue.errors.length) issue.errors.map((issues) => processError({ issues }, [...path, ...issue.path]));
		else if (issue.code === "invalid_key") processError({ issues: issue.issues }, [...path, ...issue.path]);
		else if (issue.code === "invalid_element") processError({ issues: issue.issues }, [...path, ...issue.path]);
		else {
			const fullpath = [...path, ...issue.path];
			if (fullpath.length === 0) fieldErrors._errors.push(mapper(issue));
			else {
				let curr = fieldErrors;
				let i = 0;
				while (i < fullpath.length) {
					const el = fullpath[i];
					if (!(i === fullpath.length - 1)) curr[el] = curr[el] || { _errors: [] };
					else {
						curr[el] = curr[el] || { _errors: [] };
						curr[el]._errors.push(mapper(issue));
					}
					curr = curr[el];
					i++;
				}
			}
		}
	};
	processError(error);
	return fieldErrors;
}

//#endregion
//#region ../../node_modules/.pnpm/zod@4.4.1/node_modules/zod/v4/core/parse.js
const _parse = (_Err) => (schema, value, _ctx, _params) => {
	const ctx = _ctx ? {
		..._ctx,
		async: false
	} : { async: false };
	const result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	if (result.issues.length) {
		const e = new (_params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
		captureStackTrace(e, _params?.callee);
		throw e;
	}
	return result.value;
};
const parse$1 = /* @__PURE__ */ _parse($ZodRealError);
const _parseAsync = (_Err) => async (schema, value, _ctx, params) => {
	const ctx = _ctx ? {
		..._ctx,
		async: true
	} : { async: true };
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	if (result.issues.length) {
		const e = new (params?.Err ?? _Err)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())));
		captureStackTrace(e, params?.callee);
		throw e;
	}
	return result.value;
};
const parseAsync$1 = /* @__PURE__ */ _parseAsync($ZodRealError);
const _safeParse = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: false
	} : { async: false };
	const result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) throw new $ZodAsyncError();
	return result.issues.length ? {
		success: false,
		error: new (_Err ?? $ZodError)(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	} : {
		success: true,
		data: result.value
	};
};
const safeParse$1 = /* @__PURE__ */ _safeParse($ZodRealError);
const _safeParseAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		async: true
	} : { async: true };
	let result = schema._zod.run({
		value,
		issues: []
	}, ctx);
	if (result instanceof Promise) result = await result;
	return result.issues.length ? {
		success: false,
		error: new _Err(result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	} : {
		success: true,
		data: result.value
	};
};
const safeParseAsync$1 = /* @__PURE__ */ _safeParseAsync($ZodRealError);
const _encode = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _parse(_Err)(schema, value, ctx);
};
const encode$1 = /* @__PURE__ */ _encode($ZodRealError);
const _decode = (_Err) => (schema, value, _ctx) => {
	return _parse(_Err)(schema, value, _ctx);
};
const decode$1 = /* @__PURE__ */ _decode($ZodRealError);
const _encodeAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _parseAsync(_Err)(schema, value, ctx);
};
const encodeAsync$1 = /* @__PURE__ */ _encodeAsync($ZodRealError);
const _decodeAsync = (_Err) => async (schema, value, _ctx) => {
	return _parseAsync(_Err)(schema, value, _ctx);
};
const decodeAsync$1 = /* @__PURE__ */ _decodeAsync($ZodRealError);
const _safeEncode = (_Err) => (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _safeParse(_Err)(schema, value, ctx);
};
const safeEncode$1 = /* @__PURE__ */ _safeEncode($ZodRealError);
const _safeDecode = (_Err) => (schema, value, _ctx) => {
	return _safeParse(_Err)(schema, value, _ctx);
};
const safeDecode$1 = /* @__PURE__ */ _safeDecode($ZodRealError);
const _safeEncodeAsync = (_Err) => async (schema, value, _ctx) => {
	const ctx = _ctx ? {
		..._ctx,
		direction: "backward"
	} : { direction: "backward" };
	return _safeParseAsync(_Err)(schema, value, ctx);
};
const safeEncodeAsync$1 = /* @__PURE__ */ _safeEncodeAsync($ZodRealError);
const _safeDecodeAsync = (_Err) => async (schema, value, _ctx) => {
	return _safeParseAsync(_Err)(schema, value, _ctx);
};
const safeDecodeAsync$1 = /* @__PURE__ */ _safeDecodeAsync($ZodRealError);

//#endregion
//#region ../../node_modules/.pnpm/zod@4.4.1/node_modules/zod/v4/core/regexes.js
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link cuid2} instead.
* See https://github.com/paralleldrive/cuid.
*/
const cuid = /^[cC][0-9a-z]{6,}$/;
const cuid2 = /^[0-9a-z]+$/;
const ulid = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;
const xid = /^[0-9a-vA-V]{20}$/;
const ksuid = /^[A-Za-z0-9]{27}$/;
const nanoid = /^[a-zA-Z0-9_-]{21}$/;
/** ISO 8601-1 duration regex. Does not support the 8601-2 extensions like negative durations or fractional/negative components. */
const duration$1 = /^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/;
/** A regex for any UUID-like identifier: 8-4-4-4-12 hex pattern */
const guid = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/;
/** Returns a regex for validating an RFC 9562/4122 UUID.
*
* @param version Optionally specify a version 1-8. If no version is specified, all versions are supported. */
const uuid = (version) => {
	if (!version) return /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/;
	return new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${version}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`);
};
/** Practical email validation */
const email = /^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/;
const _emoji$1 = `^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$`;
function emoji() {
	return new RegExp(_emoji$1, "u");
}
const ipv4 = /^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/;
const ipv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/;
const cidrv4 = /^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/;
const cidrv6 = /^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/;
const base64 = /^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/;
const base64url = /^[A-Za-z0-9_-]*$/;
const httpProtocol = /^https?$/;
const e164 = /^\+[1-9]\d{6,14}$/;
const dateSource = `(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))`;
const date$1 = /* @__PURE__ */ new RegExp(`^${dateSource}$`);
function timeSource(args) {
	const hhmm = `(?:[01]\\d|2[0-3]):[0-5]\\d`;
	return typeof args.precision === "number" ? args.precision === -1 ? `${hhmm}` : args.precision === 0 ? `${hhmm}:[0-5]\\d` : `${hhmm}:[0-5]\\d\\.\\d{${args.precision}}` : `${hhmm}(?::[0-5]\\d(?:\\.\\d+)?)?`;
}
function time$1(args) {
	return new RegExp(`^${timeSource(args)}$`);
}
function datetime$1(args) {
	const time = timeSource({ precision: args.precision });
	const opts = ["Z"];
	if (args.local) opts.push("");
	if (args.offset) opts.push(`([+-](?:[01]\\d|2[0-3]):[0-5]\\d)`);
	const timeRegex = `${time}(?:${opts.join("|")})`;
	return new RegExp(`^${dateSource}T(?:${timeRegex})$`);
}
const string$1 = (params) => {
	const regex = params ? `[\\s\\S]{${params?.minimum ?? 0},${params?.maximum ?? ""}}` : `[\\s\\S]*`;
	return new RegExp(`^${regex}$`);
};
const integer = /^-?\d+$/;
const number$1 = /^-?\d+(?:\.\d+)?$/;
const boolean$1 = /^(?:true|false)$/i;
const lowercase = /^[^A-Z]*$/;
const uppercase = /^[^a-z]*$/;

//#endregion
//#region ../../node_modules/.pnpm/zod@4.4.1/node_modules/zod/v4/core/checks.js
const $ZodCheck = /* @__PURE__ */ $constructor("$ZodCheck", (inst, def) => {
	var _a;
	inst._zod ?? (inst._zod = {});
	inst._zod.def = def;
	(_a = inst._zod).onattach ?? (_a.onattach = []);
});
const numericOriginMap = {
	number: "number",
	bigint: "bigint",
	object: "date"
};
const $ZodCheckLessThan = /* @__PURE__ */ $constructor("$ZodCheckLessThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		const curr = (def.inclusive ? bag.maximum : bag.exclusiveMaximum) ?? Number.POSITIVE_INFINITY;
		if (def.value < curr) if (def.inclusive) bag.maximum = def.value;
		else bag.exclusiveMaximum = def.value;
	});
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value <= def.value : payload.value < def.value) return;
		payload.issues.push({
			origin,
			code: "too_big",
			maximum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckGreaterThan = /* @__PURE__ */ $constructor("$ZodCheckGreaterThan", (inst, def) => {
	$ZodCheck.init(inst, def);
	const origin = numericOriginMap[typeof def.value];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		const curr = (def.inclusive ? bag.minimum : bag.exclusiveMinimum) ?? Number.NEGATIVE_INFINITY;
		if (def.value > curr) if (def.inclusive) bag.minimum = def.value;
		else bag.exclusiveMinimum = def.value;
	});
	inst._zod.check = (payload) => {
		if (def.inclusive ? payload.value >= def.value : payload.value > def.value) return;
		payload.issues.push({
			origin,
			code: "too_small",
			minimum: typeof def.value === "object" ? def.value.getTime() : def.value,
			input: payload.value,
			inclusive: def.inclusive,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMultipleOf = /* @__PURE__ */ $constructor("$ZodCheckMultipleOf", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.onattach.push((inst) => {
		var _a;
		(_a = inst._zod.bag).multipleOf ?? (_a.multipleOf = def.value);
	});
	inst._zod.check = (payload) => {
		if (typeof payload.value !== typeof def.value) throw new Error("Cannot mix number and bigint in multiple_of check.");
		if (typeof payload.value === "bigint" ? payload.value % def.value === BigInt(0) : floatSafeRemainder(payload.value, def.value) === 0) return;
		payload.issues.push({
			origin: typeof payload.value,
			code: "not_multiple_of",
			divisor: def.value,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckNumberFormat = /* @__PURE__ */ $constructor("$ZodCheckNumberFormat", (inst, def) => {
	$ZodCheck.init(inst, def);
	def.format = def.format || "float64";
	const isInt = def.format?.includes("int");
	const origin = isInt ? "int" : "number";
	const [minimum, maximum] = NUMBER_FORMAT_RANGES[def.format];
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.format = def.format;
		bag.minimum = minimum;
		bag.maximum = maximum;
		if (isInt) bag.pattern = integer;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (isInt) {
			if (!Number.isInteger(input)) {
				payload.issues.push({
					expected: origin,
					format: def.format,
					code: "invalid_type",
					continue: false,
					input,
					inst
				});
				return;
			}
			if (!Number.isSafeInteger(input)) {
				if (input > 0) payload.issues.push({
					input,
					code: "too_big",
					maximum: Number.MAX_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				else payload.issues.push({
					input,
					code: "too_small",
					minimum: Number.MIN_SAFE_INTEGER,
					note: "Integers must be within the safe integer range.",
					inst,
					origin,
					inclusive: true,
					continue: !def.abort
				});
				return;
			}
		}
		if (input < minimum) payload.issues.push({
			origin: "number",
			input,
			code: "too_small",
			minimum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
		if (input > maximum) payload.issues.push({
			origin: "number",
			input,
			code: "too_big",
			maximum,
			inclusive: true,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMaxLength = /* @__PURE__ */ $constructor("$ZodCheckMaxLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst) => {
		const curr = inst._zod.bag.maximum ?? Number.POSITIVE_INFINITY;
		if (def.maximum < curr) inst._zod.bag.maximum = def.maximum;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (input.length <= def.maximum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_big",
			maximum: def.maximum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckMinLength = /* @__PURE__ */ $constructor("$ZodCheckMinLength", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst) => {
		const curr = inst._zod.bag.minimum ?? Number.NEGATIVE_INFINITY;
		if (def.minimum > curr) inst._zod.bag.minimum = def.minimum;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		if (input.length >= def.minimum) return;
		const origin = getLengthableOrigin(input);
		payload.issues.push({
			origin,
			code: "too_small",
			minimum: def.minimum,
			inclusive: true,
			input,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckLengthEquals = /* @__PURE__ */ $constructor("$ZodCheckLengthEquals", (inst, def) => {
	var _a;
	$ZodCheck.init(inst, def);
	(_a = inst._zod.def).when ?? (_a.when = (payload) => {
		const val = payload.value;
		return !nullish(val) && val.length !== void 0;
	});
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.minimum = def.length;
		bag.maximum = def.length;
		bag.length = def.length;
	});
	inst._zod.check = (payload) => {
		const input = payload.value;
		const length = input.length;
		if (length === def.length) return;
		const origin = getLengthableOrigin(input);
		const tooBig = length > def.length;
		payload.issues.push({
			origin,
			...tooBig ? {
				code: "too_big",
				maximum: def.length
			} : {
				code: "too_small",
				minimum: def.length
			},
			inclusive: true,
			exact: true,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckStringFormat = /* @__PURE__ */ $constructor("$ZodCheckStringFormat", (inst, def) => {
	var _a, _b;
	$ZodCheck.init(inst, def);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.format = def.format;
		if (def.pattern) {
			bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
			bag.patterns.add(def.pattern);
		}
	});
	if (def.pattern) (_a = inst._zod).check ?? (_a.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: def.format,
			input: payload.value,
			...def.pattern ? { pattern: def.pattern.toString() } : {},
			inst,
			continue: !def.abort
		});
	});
	else (_b = inst._zod).check ?? (_b.check = () => {});
});
const $ZodCheckRegex = /* @__PURE__ */ $constructor("$ZodCheckRegex", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		def.pattern.lastIndex = 0;
		if (def.pattern.test(payload.value)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "regex",
			input: payload.value,
			pattern: def.pattern.toString(),
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckLowerCase = /* @__PURE__ */ $constructor("$ZodCheckLowerCase", (inst, def) => {
	def.pattern ?? (def.pattern = lowercase);
	$ZodCheckStringFormat.init(inst, def);
});
const $ZodCheckUpperCase = /* @__PURE__ */ $constructor("$ZodCheckUpperCase", (inst, def) => {
	def.pattern ?? (def.pattern = uppercase);
	$ZodCheckStringFormat.init(inst, def);
});
const $ZodCheckIncludes = /* @__PURE__ */ $constructor("$ZodCheckIncludes", (inst, def) => {
	$ZodCheck.init(inst, def);
	const escapedRegex = escapeRegex(def.includes);
	const pattern = new RegExp(typeof def.position === "number" ? `^.{${def.position}}${escapedRegex}` : escapedRegex);
	def.pattern = pattern;
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.includes(def.includes, def.position)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "includes",
			includes: def.includes,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckStartsWith = /* @__PURE__ */ $constructor("$ZodCheckStartsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`^${escapeRegex(def.prefix)}.*`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.startsWith(def.prefix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "starts_with",
			prefix: def.prefix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckEndsWith = /* @__PURE__ */ $constructor("$ZodCheckEndsWith", (inst, def) => {
	$ZodCheck.init(inst, def);
	const pattern = new RegExp(`.*${escapeRegex(def.suffix)}$`);
	def.pattern ?? (def.pattern = pattern);
	inst._zod.onattach.push((inst) => {
		const bag = inst._zod.bag;
		bag.patterns ?? (bag.patterns = /* @__PURE__ */ new Set());
		bag.patterns.add(pattern);
	});
	inst._zod.check = (payload) => {
		if (payload.value.endsWith(def.suffix)) return;
		payload.issues.push({
			origin: "string",
			code: "invalid_format",
			format: "ends_with",
			suffix: def.suffix,
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodCheckOverwrite = /* @__PURE__ */ $constructor("$ZodCheckOverwrite", (inst, def) => {
	$ZodCheck.init(inst, def);
	inst._zod.check = (payload) => {
		payload.value = def.tx(payload.value);
	};
});

//#endregion
//#region ../../node_modules/.pnpm/zod@4.4.1/node_modules/zod/v4/core/doc.js
var Doc = class {
	constructor(args = []) {
		this.content = [];
		this.indent = 0;
		if (this) this.args = args;
	}
	indented(fn) {
		this.indent += 1;
		fn(this);
		this.indent -= 1;
	}
	write(arg) {
		if (typeof arg === "function") {
			arg(this, { execution: "sync" });
			arg(this, { execution: "async" });
			return;
		}
		const lines = arg.split("\n").filter((x) => x);
		const minIndent = Math.min(...lines.map((x) => x.length - x.trimStart().length));
		const dedented = lines.map((x) => x.slice(minIndent)).map((x) => " ".repeat(this.indent * 2) + x);
		for (const line of dedented) this.content.push(line);
	}
	compile() {
		const F = Function;
		const args = this?.args;
		const lines = [...(this?.content ?? [``]).map((x) => `  ${x}`)];
		return new F(...args, lines.join("\n"));
	}
};

//#endregion
//#region ../../node_modules/.pnpm/zod@4.4.1/node_modules/zod/v4/core/versions.js
const version = {
	major: 4,
	minor: 4,
	patch: 1
};

//#endregion
//#region ../../node_modules/.pnpm/zod@4.4.1/node_modules/zod/v4/core/schemas.js
const $ZodType = /* @__PURE__ */ $constructor("$ZodType", (inst, def) => {
	var _a;
	inst ?? (inst = {});
	inst._zod.def = def;
	inst._zod.bag = inst._zod.bag || {};
	inst._zod.version = version;
	const checks = [...inst._zod.def.checks ?? []];
	if (inst._zod.traits.has("$ZodCheck")) checks.unshift(inst);
	for (const ch of checks) for (const fn of ch._zod.onattach) fn(inst);
	if (checks.length === 0) {
		(_a = inst._zod).deferred ?? (_a.deferred = []);
		inst._zod.deferred?.push(() => {
			inst._zod.run = inst._zod.parse;
		});
	} else {
		const runChecks = (payload, checks, ctx) => {
			let isAborted = aborted(payload);
			let asyncResult;
			for (const ch of checks) {
				if (ch._zod.def.when) {
					if (explicitlyAborted(payload)) continue;
					if (!ch._zod.def.when(payload)) continue;
				} else if (isAborted) continue;
				const currLen = payload.issues.length;
				const _ = ch._zod.check(payload);
				if (_ instanceof Promise && ctx?.async === false) throw new $ZodAsyncError();
				if (asyncResult || _ instanceof Promise) asyncResult = (asyncResult ?? Promise.resolve()).then(async () => {
					await _;
					if (payload.issues.length === currLen) return;
					if (!isAborted) isAborted = aborted(payload, currLen);
				});
				else {
					if (payload.issues.length === currLen) continue;
					if (!isAborted) isAborted = aborted(payload, currLen);
				}
			}
			if (asyncResult) return asyncResult.then(() => {
				return payload;
			});
			return payload;
		};
		const handleCanaryResult = (canary, payload, ctx) => {
			if (aborted(canary)) {
				canary.aborted = true;
				return canary;
			}
			const checkResult = runChecks(payload, checks, ctx);
			if (checkResult instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return checkResult.then((checkResult) => inst._zod.parse(checkResult, ctx));
			}
			return inst._zod.parse(checkResult, ctx);
		};
		inst._zod.run = (payload, ctx) => {
			if (ctx.skipChecks) return inst._zod.parse(payload, ctx);
			if (ctx.direction === "backward") {
				const canary = inst._zod.parse({
					value: payload.value,
					issues: []
				}, {
					...ctx,
					skipChecks: true
				});
				if (canary instanceof Promise) return canary.then((canary) => {
					return handleCanaryResult(canary, payload, ctx);
				});
				return handleCanaryResult(canary, payload, ctx);
			}
			const result = inst._zod.parse(payload, ctx);
			if (result instanceof Promise) {
				if (ctx.async === false) throw new $ZodAsyncError();
				return result.then((result) => runChecks(result, checks, ctx));
			}
			return runChecks(result, checks, ctx);
		};
	}
	defineLazy(inst, "~standard", () => ({
		validate: (value) => {
			try {
				const r = safeParse$1(inst, value);
				return r.success ? { value: r.data } : { issues: r.error?.issues };
			} catch (_) {
				return safeParseAsync$1(inst, value).then((r) => r.success ? { value: r.data } : { issues: r.error?.issues });
			}
		},
		vendor: "zod",
		version: 1
	}));
});
const $ZodString = /* @__PURE__ */ $constructor("$ZodString", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = [...inst?._zod.bag?.patterns ?? []].pop() ?? string$1(inst._zod.bag);
	inst._zod.parse = (payload, _) => {
		if (def.coerce) try {
			payload.value = String(payload.value);
		} catch (_) {}
		if (typeof payload.value === "string") return payload;
		payload.issues.push({
			expected: "string",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
const $ZodStringFormat = /* @__PURE__ */ $constructor("$ZodStringFormat", (inst, def) => {
	$ZodCheckStringFormat.init(inst, def);
	$ZodString.init(inst, def);
});
const $ZodGUID = /* @__PURE__ */ $constructor("$ZodGUID", (inst, def) => {
	def.pattern ?? (def.pattern = guid);
	$ZodStringFormat.init(inst, def);
});
const $ZodUUID = /* @__PURE__ */ $constructor("$ZodUUID", (inst, def) => {
	if (def.version) {
		const v = {
			v1: 1,
			v2: 2,
			v3: 3,
			v4: 4,
			v5: 5,
			v6: 6,
			v7: 7,
			v8: 8
		}[def.version];
		if (v === void 0) throw new Error(`Invalid UUID version: "${def.version}"`);
		def.pattern ?? (def.pattern = uuid(v));
	} else def.pattern ?? (def.pattern = uuid());
	$ZodStringFormat.init(inst, def);
});
const $ZodEmail = /* @__PURE__ */ $constructor("$ZodEmail", (inst, def) => {
	def.pattern ?? (def.pattern = email);
	$ZodStringFormat.init(inst, def);
});
const $ZodURL = /* @__PURE__ */ $constructor("$ZodURL", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		try {
			const trimmed = payload.value.trim();
			if (!def.normalize && def.protocol?.source === httpProtocol.source) {
				if (!/^https?:\/\//i.test(trimmed)) {
					payload.issues.push({
						code: "invalid_format",
						format: "url",
						note: "Invalid URL format",
						input: payload.value,
						inst,
						continue: !def.abort
					});
					return;
				}
			}
			const url = new URL(trimmed);
			if (def.hostname) {
				def.hostname.lastIndex = 0;
				if (!def.hostname.test(url.hostname)) payload.issues.push({
					code: "invalid_format",
					format: "url",
					note: "Invalid hostname",
					pattern: def.hostname.source,
					input: payload.value,
					inst,
					continue: !def.abort
				});
			}
			if (def.protocol) {
				def.protocol.lastIndex = 0;
				if (!def.protocol.test(url.protocol.endsWith(":") ? url.protocol.slice(0, -1) : url.protocol)) payload.issues.push({
					code: "invalid_format",
					format: "url",
					note: "Invalid protocol",
					pattern: def.protocol.source,
					input: payload.value,
					inst,
					continue: !def.abort
				});
			}
			if (def.normalize) payload.value = url.href;
			else payload.value = trimmed;
			return;
		} catch (_) {
			payload.issues.push({
				code: "invalid_format",
				format: "url",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
const $ZodEmoji = /* @__PURE__ */ $constructor("$ZodEmoji", (inst, def) => {
	def.pattern ?? (def.pattern = emoji());
	$ZodStringFormat.init(inst, def);
});
const $ZodNanoID = /* @__PURE__ */ $constructor("$ZodNanoID", (inst, def) => {
	def.pattern ?? (def.pattern = nanoid);
	$ZodStringFormat.init(inst, def);
});
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link $ZodCUID2} instead.
* See https://github.com/paralleldrive/cuid.
*/
const $ZodCUID = /* @__PURE__ */ $constructor("$ZodCUID", (inst, def) => {
	def.pattern ?? (def.pattern = cuid);
	$ZodStringFormat.init(inst, def);
});
const $ZodCUID2 = /* @__PURE__ */ $constructor("$ZodCUID2", (inst, def) => {
	def.pattern ?? (def.pattern = cuid2);
	$ZodStringFormat.init(inst, def);
});
const $ZodULID = /* @__PURE__ */ $constructor("$ZodULID", (inst, def) => {
	def.pattern ?? (def.pattern = ulid);
	$ZodStringFormat.init(inst, def);
});
const $ZodXID = /* @__PURE__ */ $constructor("$ZodXID", (inst, def) => {
	def.pattern ?? (def.pattern = xid);
	$ZodStringFormat.init(inst, def);
});
const $ZodKSUID = /* @__PURE__ */ $constructor("$ZodKSUID", (inst, def) => {
	def.pattern ?? (def.pattern = ksuid);
	$ZodStringFormat.init(inst, def);
});
const $ZodISODateTime = /* @__PURE__ */ $constructor("$ZodISODateTime", (inst, def) => {
	def.pattern ?? (def.pattern = datetime$1(def));
	$ZodStringFormat.init(inst, def);
});
const $ZodISODate = /* @__PURE__ */ $constructor("$ZodISODate", (inst, def) => {
	def.pattern ?? (def.pattern = date$1);
	$ZodStringFormat.init(inst, def);
});
const $ZodISOTime = /* @__PURE__ */ $constructor("$ZodISOTime", (inst, def) => {
	def.pattern ?? (def.pattern = time$1(def));
	$ZodStringFormat.init(inst, def);
});
const $ZodISODuration = /* @__PURE__ */ $constructor("$ZodISODuration", (inst, def) => {
	def.pattern ?? (def.pattern = duration$1);
	$ZodStringFormat.init(inst, def);
});
const $ZodIPv4 = /* @__PURE__ */ $constructor("$ZodIPv4", (inst, def) => {
	def.pattern ?? (def.pattern = ipv4);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.format = `ipv4`;
});
const $ZodIPv6 = /* @__PURE__ */ $constructor("$ZodIPv6", (inst, def) => {
	def.pattern ?? (def.pattern = ipv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.format = `ipv6`;
	inst._zod.check = (payload) => {
		try {
			new URL(`http://[${payload.value}]`);
		} catch {
			payload.issues.push({
				code: "invalid_format",
				format: "ipv6",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
const $ZodCIDRv4 = /* @__PURE__ */ $constructor("$ZodCIDRv4", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv4);
	$ZodStringFormat.init(inst, def);
});
const $ZodCIDRv6 = /* @__PURE__ */ $constructor("$ZodCIDRv6", (inst, def) => {
	def.pattern ?? (def.pattern = cidrv6);
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		const parts = payload.value.split("/");
		try {
			if (parts.length !== 2) throw new Error();
			const [address, prefix] = parts;
			if (!prefix) throw new Error();
			const prefixNum = Number(prefix);
			if (`${prefixNum}` !== prefix) throw new Error();
			if (prefixNum < 0 || prefixNum > 128) throw new Error();
			new URL(`http://[${address}]`);
		} catch {
			payload.issues.push({
				code: "invalid_format",
				format: "cidrv6",
				input: payload.value,
				inst,
				continue: !def.abort
			});
		}
	};
});
function isValidBase64(data) {
	if (data === "") return true;
	if (/\s/.test(data)) return false;
	if (data.length % 4 !== 0) return false;
	try {
		atob(data);
		return true;
	} catch {
		return false;
	}
}
const $ZodBase64 = /* @__PURE__ */ $constructor("$ZodBase64", (inst, def) => {
	def.pattern ?? (def.pattern = base64);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.contentEncoding = "base64";
	inst._zod.check = (payload) => {
		if (isValidBase64(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
function isValidBase64URL(data) {
	if (!base64url.test(data)) return false;
	const base64 = data.replace(/[-_]/g, (c) => c === "-" ? "+" : "/");
	return isValidBase64(base64.padEnd(Math.ceil(base64.length / 4) * 4, "="));
}
const $ZodBase64URL = /* @__PURE__ */ $constructor("$ZodBase64URL", (inst, def) => {
	def.pattern ?? (def.pattern = base64url);
	$ZodStringFormat.init(inst, def);
	inst._zod.bag.contentEncoding = "base64url";
	inst._zod.check = (payload) => {
		if (isValidBase64URL(payload.value)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "base64url",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodE164 = /* @__PURE__ */ $constructor("$ZodE164", (inst, def) => {
	def.pattern ?? (def.pattern = e164);
	$ZodStringFormat.init(inst, def);
});
function isValidJWT(token, algorithm = null) {
	try {
		const tokensParts = token.split(".");
		if (tokensParts.length !== 3) return false;
		const [header] = tokensParts;
		if (!header) return false;
		const parsedHeader = JSON.parse(atob(header));
		if ("typ" in parsedHeader && parsedHeader?.typ !== "JWT") return false;
		if (!parsedHeader.alg) return false;
		if (algorithm && (!("alg" in parsedHeader) || parsedHeader.alg !== algorithm)) return false;
		return true;
	} catch {
		return false;
	}
}
const $ZodJWT = /* @__PURE__ */ $constructor("$ZodJWT", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	inst._zod.check = (payload) => {
		if (isValidJWT(payload.value, def.alg)) return;
		payload.issues.push({
			code: "invalid_format",
			format: "jwt",
			input: payload.value,
			inst,
			continue: !def.abort
		});
	};
});
const $ZodNumber = /* @__PURE__ */ $constructor("$ZodNumber", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = inst._zod.bag.pattern ?? number$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Number(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "number" && !Number.isNaN(input) && Number.isFinite(input)) return payload;
		const received = typeof input === "number" ? Number.isNaN(input) ? "NaN" : !Number.isFinite(input) ? "Infinity" : void 0 : void 0;
		payload.issues.push({
			expected: "number",
			code: "invalid_type",
			input,
			inst,
			...received ? { received } : {}
		});
		return payload;
	};
});
const $ZodNumberFormat = /* @__PURE__ */ $constructor("$ZodNumberFormat", (inst, def) => {
	$ZodCheckNumberFormat.init(inst, def);
	$ZodNumber.init(inst, def);
});
const $ZodBoolean = /* @__PURE__ */ $constructor("$ZodBoolean", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.pattern = boolean$1;
	inst._zod.parse = (payload, _ctx) => {
		if (def.coerce) try {
			payload.value = Boolean(payload.value);
		} catch (_) {}
		const input = payload.value;
		if (typeof input === "boolean") return payload;
		payload.issues.push({
			expected: "boolean",
			code: "invalid_type",
			input,
			inst
		});
		return payload;
	};
});
const $ZodUnknown = /* @__PURE__ */ $constructor("$ZodUnknown", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload) => payload;
});
const $ZodNever = /* @__PURE__ */ $constructor("$ZodNever", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _ctx) => {
		payload.issues.push({
			expected: "never",
			code: "invalid_type",
			input: payload.value,
			inst
		});
		return payload;
	};
});
function handleArrayResult(result, final, index) {
	if (result.issues.length) final.issues.push(...prefixIssues(index, result.issues));
	final.value[index] = result.value;
}
const $ZodArray = /* @__PURE__ */ $constructor("$ZodArray", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!Array.isArray(input)) {
			payload.issues.push({
				expected: "array",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = Array(input.length);
		const proms = [];
		for (let i = 0; i < input.length; i++) {
			const item = input[i];
			const result = def.element._zod.run({
				value: item,
				issues: []
			}, ctx);
			if (result instanceof Promise) proms.push(result.then((result) => handleArrayResult(result, payload, i)));
			else handleArrayResult(result, payload, i);
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
});
function handlePropertyResult(result, final, key, input, isOptionalIn, isOptionalOut) {
	const isPresent = key in input;
	if (result.issues.length) {
		if (isOptionalIn && isOptionalOut && !isPresent) return;
		final.issues.push(...prefixIssues(key, result.issues));
	}
	if (!isPresent && !isOptionalIn) {
		if (!result.issues.length) final.issues.push({
			code: "invalid_type",
			expected: "nonoptional",
			input: void 0,
			path: [key]
		});
		return;
	}
	if (result.value === void 0) {
		if (isPresent) final.value[key] = void 0;
	} else final.value[key] = result.value;
}
function normalizeDef(def) {
	const keys = Object.keys(def.shape);
	for (const k of keys) if (!def.shape?.[k]?._zod?.traits?.has("$ZodType")) throw new Error(`Invalid element at key "${k}": expected a Zod schema`);
	const okeys = optionalKeys(def.shape);
	return {
		...def,
		keys,
		keySet: new Set(keys),
		numKeys: keys.length,
		optionalKeys: new Set(okeys)
	};
}
function handleCatchall(proms, input, payload, ctx, def, inst) {
	const unrecognized = [];
	const keySet = def.keySet;
	const _catchall = def.catchall._zod;
	const t = _catchall.def.type;
	const isOptionalIn = _catchall.optin === "optional";
	const isOptionalOut = _catchall.optout === "optional";
	for (const key in input) {
		if (key === "__proto__") continue;
		if (keySet.has(key)) continue;
		if (t === "never") {
			unrecognized.push(key);
			continue;
		}
		const r = _catchall.run({
			value: input[key],
			issues: []
		}, ctx);
		if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut)));
		else handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
	}
	if (unrecognized.length) payload.issues.push({
		code: "unrecognized_keys",
		keys: unrecognized,
		input,
		inst
	});
	if (!proms.length) return payload;
	return Promise.all(proms).then(() => {
		return payload;
	});
}
const $ZodObject = /* @__PURE__ */ $constructor("$ZodObject", (inst, def) => {
	$ZodType.init(inst, def);
	if (!Object.getOwnPropertyDescriptor(def, "shape")?.get) {
		const sh = def.shape;
		Object.defineProperty(def, "shape", { get: () => {
			const newSh = { ...sh };
			Object.defineProperty(def, "shape", { value: newSh });
			return newSh;
		} });
	}
	const _normalized = cached(() => normalizeDef(def));
	defineLazy(inst._zod, "propValues", () => {
		const shape = def.shape;
		const propValues = {};
		for (const key in shape) {
			const field = shape[key]._zod;
			if (field.values) {
				propValues[key] ?? (propValues[key] = /* @__PURE__ */ new Set());
				for (const v of field.values) propValues[key].add(v);
			}
		}
		return propValues;
	});
	const isObject$2 = isObject;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$2(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		payload.value = {};
		const proms = [];
		const shape = value.shape;
		for (const key of value.keys) {
			const el = shape[key];
			const isOptionalIn = el._zod.optin === "optional";
			const isOptionalOut = el._zod.optout === "optional";
			const r = el._zod.run({
				value: input[key],
				issues: []
			}, ctx);
			if (r instanceof Promise) proms.push(r.then((r) => handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut)));
			else handlePropertyResult(r, payload, key, input, isOptionalIn, isOptionalOut);
		}
		if (!catchall) return proms.length ? Promise.all(proms).then(() => payload) : payload;
		return handleCatchall(proms, input, payload, ctx, _normalized.value, inst);
	};
});
const $ZodObjectJIT = /* @__PURE__ */ $constructor("$ZodObjectJIT", (inst, def) => {
	$ZodObject.init(inst, def);
	const superParse = inst._zod.parse;
	const _normalized = cached(() => normalizeDef(def));
	const generateFastpass = (shape) => {
		const doc = new Doc([
			"shape",
			"payload",
			"ctx"
		]);
		const normalized = _normalized.value;
		const parseStr = (key) => {
			const k = esc(key);
			return `shape[${k}]._zod.run({ value: input[${k}], issues: [] }, ctx)`;
		};
		doc.write(`const input = payload.value;`);
		const ids = Object.create(null);
		let counter = 0;
		for (const key of normalized.keys) ids[key] = `key_${counter++}`;
		doc.write(`const newResult = {};`);
		for (const key of normalized.keys) {
			const id = ids[key];
			const k = esc(key);
			const schema = shape[key];
			const isOptionalIn = schema?._zod?.optin === "optional";
			const isOptionalOut = schema?._zod?.optout === "optional";
			doc.write(`const ${id} = ${parseStr(key)};`);
			if (isOptionalIn && isOptionalOut) doc.write(`
        if (${id}.issues.length) {
          if (${k} in input) {
            payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
              ...iss,
              path: iss.path ? [${k}, ...iss.path] : [${k}]
            })));
          }
        }

        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }

      `);
			else if (!isOptionalIn) doc.write(`
        const ${id}_present = ${k} in input;
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }
        if (!${id}_present && !${id}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${k}]
          });
        }

        if (${id}_present) {
          if (${id}.value === undefined) {
            newResult[${k}] = undefined;
          } else {
            newResult[${k}] = ${id}.value;
          }
        }

      `);
			else doc.write(`
        if (${id}.issues.length) {
          payload.issues = payload.issues.concat(${id}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${k}, ...iss.path] : [${k}]
          })));
        }

        if (${id}.value === undefined) {
          if (${k} in input) {
            newResult[${k}] = undefined;
          }
        } else {
          newResult[${k}] = ${id}.value;
        }

      `);
		}
		doc.write(`payload.value = newResult;`);
		doc.write(`return payload;`);
		const fn = doc.compile();
		return (payload, ctx) => fn(shape, payload, ctx);
	};
	let fastpass;
	const isObject$3 = isObject;
	const jit = !globalConfig.jitless;
	const allowsEval$2 = allowsEval;
	const fastEnabled = jit && allowsEval$2.value;
	const catchall = def.catchall;
	let value;
	inst._zod.parse = (payload, ctx) => {
		value ?? (value = _normalized.value);
		const input = payload.value;
		if (!isObject$3(input)) {
			payload.issues.push({
				expected: "object",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		if (jit && fastEnabled && ctx?.async === false && ctx.jitless !== true) {
			if (!fastpass) fastpass = generateFastpass(def.shape);
			payload = fastpass(payload, ctx);
			if (!catchall) return payload;
			return handleCatchall([], input, payload, ctx, value, inst);
		}
		return superParse(payload, ctx);
	};
});
function handleUnionResults(results, final, inst, ctx) {
	for (const result of results) if (result.issues.length === 0) {
		final.value = result.value;
		return final;
	}
	const nonaborted = results.filter((r) => !aborted(r));
	if (nonaborted.length === 1) {
		final.value = nonaborted[0].value;
		return nonaborted[0];
	}
	final.issues.push({
		code: "invalid_union",
		input: final.value,
		inst,
		errors: results.map((result) => result.issues.map((iss) => finalizeIssue(iss, ctx, config())))
	});
	return final;
}
const $ZodUnion = /* @__PURE__ */ $constructor("$ZodUnion", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "optin", () => def.options.some((o) => o._zod.optin === "optional") ? "optional" : void 0);
	defineLazy(inst._zod, "optout", () => def.options.some((o) => o._zod.optout === "optional") ? "optional" : void 0);
	defineLazy(inst._zod, "values", () => {
		if (def.options.every((o) => o._zod.values)) return new Set(def.options.flatMap((option) => Array.from(option._zod.values)));
	});
	defineLazy(inst._zod, "pattern", () => {
		if (def.options.every((o) => o._zod.pattern)) {
			const patterns = def.options.map((o) => o._zod.pattern);
			return new RegExp(`^(${patterns.map((p) => cleanRegex(p.source)).join("|")})$`);
		}
	});
	const first = def.options.length === 1 ? def.options[0]._zod.run : null;
	inst._zod.parse = (payload, ctx) => {
		if (first) return first(payload, ctx);
		let async = false;
		const results = [];
		for (const option of def.options) {
			const result = option._zod.run({
				value: payload.value,
				issues: []
			}, ctx);
			if (result instanceof Promise) {
				results.push(result);
				async = true;
			} else {
				if (result.issues.length === 0) return result;
				results.push(result);
			}
		}
		if (!async) return handleUnionResults(results, payload, inst, ctx);
		return Promise.all(results).then((results) => {
			return handleUnionResults(results, payload, inst, ctx);
		});
	};
});
const $ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("$ZodDiscriminatedUnion", (inst, def) => {
	def.inclusive = false;
	$ZodUnion.init(inst, def);
	const _super = inst._zod.parse;
	defineLazy(inst._zod, "propValues", () => {
		const propValues = {};
		for (const option of def.options) {
			const pv = option._zod.propValues;
			if (!pv || Object.keys(pv).length === 0) throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(option)}"`);
			for (const [k, v] of Object.entries(pv)) {
				if (!propValues[k]) propValues[k] = /* @__PURE__ */ new Set();
				for (const val of v) propValues[k].add(val);
			}
		}
		return propValues;
	});
	const disc = cached(() => {
		const opts = def.options;
		const map = /* @__PURE__ */ new Map();
		for (const o of opts) {
			const values = o._zod.propValues?.[def.discriminator];
			if (!values || values.size === 0) throw new Error(`Invalid discriminated union option at index "${def.options.indexOf(o)}"`);
			for (const v of values) {
				if (map.has(v)) throw new Error(`Duplicate discriminator value "${String(v)}"`);
				map.set(v, o);
			}
		}
		return map;
	});
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!isObject(input)) {
			payload.issues.push({
				code: "invalid_type",
				expected: "object",
				input,
				inst
			});
			return payload;
		}
		const opt = disc.value.get(input?.[def.discriminator]);
		if (opt) return opt._zod.run(payload, ctx);
		if (def.unionFallback || ctx.direction === "backward") return _super(payload, ctx);
		payload.issues.push({
			code: "invalid_union",
			errors: [],
			note: "No matching discriminator",
			discriminator: def.discriminator,
			options: Array.from(disc.value.keys()),
			input,
			path: [def.discriminator],
			inst
		});
		return payload;
	};
});
const $ZodIntersection = /* @__PURE__ */ $constructor("$ZodIntersection", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		const left = def.left._zod.run({
			value: input,
			issues: []
		}, ctx);
		const right = def.right._zod.run({
			value: input,
			issues: []
		}, ctx);
		if (left instanceof Promise || right instanceof Promise) return Promise.all([left, right]).then(([left, right]) => {
			return handleIntersectionResults(payload, left, right);
		});
		return handleIntersectionResults(payload, left, right);
	};
});
function mergeValues(a, b) {
	if (a === b) return {
		valid: true,
		data: a
	};
	if (a instanceof Date && b instanceof Date && +a === +b) return {
		valid: true,
		data: a
	};
	if (isPlainObject(a) && isPlainObject(b)) {
		const bKeys = Object.keys(b);
		const sharedKeys = Object.keys(a).filter((key) => bKeys.indexOf(key) !== -1);
		const newObj = {
			...a,
			...b
		};
		for (const key of sharedKeys) {
			const sharedValue = mergeValues(a[key], b[key]);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [key, ...sharedValue.mergeErrorPath]
			};
			newObj[key] = sharedValue.data;
		}
		return {
			valid: true,
			data: newObj
		};
	}
	if (Array.isArray(a) && Array.isArray(b)) {
		if (a.length !== b.length) return {
			valid: false,
			mergeErrorPath: []
		};
		const newArray = [];
		for (let index = 0; index < a.length; index++) {
			const itemA = a[index];
			const itemB = b[index];
			const sharedValue = mergeValues(itemA, itemB);
			if (!sharedValue.valid) return {
				valid: false,
				mergeErrorPath: [index, ...sharedValue.mergeErrorPath]
			};
			newArray.push(sharedValue.data);
		}
		return {
			valid: true,
			data: newArray
		};
	}
	return {
		valid: false,
		mergeErrorPath: []
	};
}
function handleIntersectionResults(result, left, right) {
	const unrecKeys = /* @__PURE__ */ new Map();
	let unrecIssue;
	for (const iss of left.issues) if (iss.code === "unrecognized_keys") {
		unrecIssue ?? (unrecIssue = iss);
		for (const k of iss.keys) {
			if (!unrecKeys.has(k)) unrecKeys.set(k, {});
			unrecKeys.get(k).l = true;
		}
	} else result.issues.push(iss);
	for (const iss of right.issues) if (iss.code === "unrecognized_keys") for (const k of iss.keys) {
		if (!unrecKeys.has(k)) unrecKeys.set(k, {});
		unrecKeys.get(k).r = true;
	}
	else result.issues.push(iss);
	const bothKeys = [...unrecKeys].filter(([, f]) => f.l && f.r).map(([k]) => k);
	if (bothKeys.length && unrecIssue) result.issues.push({
		...unrecIssue,
		keys: bothKeys
	});
	if (aborted(result)) return result;
	const merged = mergeValues(left.value, right.value);
	if (!merged.valid) throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(merged.mergeErrorPath)}`);
	result.value = merged.data;
	return result;
}
const $ZodRecord = /* @__PURE__ */ $constructor("$ZodRecord", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		const input = payload.value;
		if (!isPlainObject(input)) {
			payload.issues.push({
				expected: "record",
				code: "invalid_type",
				input,
				inst
			});
			return payload;
		}
		const proms = [];
		const values = def.keyType._zod.values;
		if (values) {
			payload.value = {};
			const recordKeys = /* @__PURE__ */ new Set();
			for (const key of values) if (typeof key === "string" || typeof key === "number" || typeof key === "symbol") {
				recordKeys.add(typeof key === "number" ? key.toString() : key);
				const keyResult = def.keyType._zod.run({
					value: key,
					issues: []
				}, ctx);
				if (keyResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
				if (keyResult.issues.length) {
					payload.issues.push({
						code: "invalid_key",
						origin: "record",
						issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
						input: key,
						path: [key],
						inst
					});
					continue;
				}
				const outKey = keyResult.value;
				const result = def.valueType._zod.run({
					value: input[key],
					issues: []
				}, ctx);
				if (result instanceof Promise) proms.push(result.then((result) => {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[outKey] = result.value;
				}));
				else {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[outKey] = result.value;
				}
			}
			let unrecognized;
			for (const key in input) if (!recordKeys.has(key)) {
				unrecognized = unrecognized ?? [];
				unrecognized.push(key);
			}
			if (unrecognized && unrecognized.length > 0) payload.issues.push({
				code: "unrecognized_keys",
				input,
				inst,
				keys: unrecognized
			});
		} else {
			payload.value = {};
			for (const key of Reflect.ownKeys(input)) {
				if (key === "__proto__") continue;
				if (!Object.prototype.propertyIsEnumerable.call(input, key)) continue;
				let keyResult = def.keyType._zod.run({
					value: key,
					issues: []
				}, ctx);
				if (keyResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
				if (typeof key === "string" && number$1.test(key) && keyResult.issues.length) {
					const retryResult = def.keyType._zod.run({
						value: Number(key),
						issues: []
					}, ctx);
					if (retryResult instanceof Promise) throw new Error("Async schemas not supported in object keys currently");
					if (retryResult.issues.length === 0) keyResult = retryResult;
				}
				if (keyResult.issues.length) {
					if (def.mode === "loose") payload.value[key] = input[key];
					else payload.issues.push({
						code: "invalid_key",
						origin: "record",
						issues: keyResult.issues.map((iss) => finalizeIssue(iss, ctx, config())),
						input: key,
						path: [key],
						inst
					});
					continue;
				}
				const result = def.valueType._zod.run({
					value: input[key],
					issues: []
				}, ctx);
				if (result instanceof Promise) proms.push(result.then((result) => {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[keyResult.value] = result.value;
				}));
				else {
					if (result.issues.length) payload.issues.push(...prefixIssues(key, result.issues));
					payload.value[keyResult.value] = result.value;
				}
			}
		}
		if (proms.length) return Promise.all(proms).then(() => payload);
		return payload;
	};
});
const $ZodEnum = /* @__PURE__ */ $constructor("$ZodEnum", (inst, def) => {
	$ZodType.init(inst, def);
	const values = getEnumValues(def.entries);
	const valuesSet = new Set(values);
	inst._zod.values = valuesSet;
	inst._zod.pattern = new RegExp(`^(${values.filter((k) => propertyKeyTypes.has(typeof k)).map((o) => typeof o === "string" ? escapeRegex(o) : o.toString()).join("|")})$`);
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (valuesSet.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values,
			input,
			inst
		});
		return payload;
	};
});
const $ZodLiteral = /* @__PURE__ */ $constructor("$ZodLiteral", (inst, def) => {
	$ZodType.init(inst, def);
	if (def.values.length === 0) throw new Error("Cannot create literal schema with no valid values");
	const values = new Set(def.values);
	inst._zod.values = values;
	inst._zod.pattern = new RegExp(`^(${def.values.map((o) => typeof o === "string" ? escapeRegex(o) : o ? escapeRegex(o.toString()) : String(o)).join("|")})$`);
	inst._zod.parse = (payload, _ctx) => {
		const input = payload.value;
		if (values.has(input)) return payload;
		payload.issues.push({
			code: "invalid_value",
			values: def.values,
			input,
			inst
		});
		return payload;
	};
});
const $ZodTransform = /* @__PURE__ */ $constructor("$ZodTransform", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		const _out = def.transform(payload.value, payload);
		if (ctx.async) return (_out instanceof Promise ? _out : Promise.resolve(_out)).then((output) => {
			payload.value = output;
			return payload;
		});
		if (_out instanceof Promise) throw new $ZodAsyncError();
		payload.value = _out;
		return payload;
	};
});
function handleOptionalResult(result, input) {
	if (result.issues.length && input === void 0) return {
		issues: [],
		value: void 0
	};
	return result;
}
const $ZodOptional = /* @__PURE__ */ $constructor("$ZodOptional", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	inst._zod.optout = "optional";
	defineLazy(inst._zod, "values", () => {
		return def.innerType._zod.values ? new Set([...def.innerType._zod.values, void 0]) : void 0;
	});
	defineLazy(inst._zod, "pattern", () => {
		const pattern = def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)})?$`) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (def.innerType._zod.optin === "optional") {
			const result = def.innerType._zod.run(payload, ctx);
			if (result instanceof Promise) return result.then((r) => handleOptionalResult(r, payload.value));
			return handleOptionalResult(result, payload.value);
		}
		if (payload.value === void 0) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodExactOptional = /* @__PURE__ */ $constructor("$ZodExactOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	defineLazy(inst._zod, "pattern", () => def.innerType._zod.pattern);
	inst._zod.parse = (payload, ctx) => {
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodNullable = /* @__PURE__ */ $constructor("$ZodNullable", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
	defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
	defineLazy(inst._zod, "pattern", () => {
		const pattern = def.innerType._zod.pattern;
		return pattern ? new RegExp(`^(${cleanRegex(pattern.source)}|null)$`) : void 0;
	});
	defineLazy(inst._zod, "values", () => {
		return def.innerType._zod.values ? new Set([...def.innerType._zod.values, null]) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		if (payload.value === null) return payload;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodDefault = /* @__PURE__ */ $constructor("$ZodDefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) {
			payload.value = def.defaultValue;
			/**
			* $ZodDefault returns the default value immediately in forward direction.
			* It doesn't pass the default value into the validator ("prefault"). There's no reason to pass the default value through validation. The validity of the default is enforced by TypeScript statically. Otherwise, it's the responsibility of the user to ensure the default is valid. In the case of pipes with divergent in/out types, you can specify the default on the `in` schema of your ZodPipe to set a "prefault" for the pipe.   */
			return payload;
		}
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleDefaultResult(result, def));
		return handleDefaultResult(result, def);
	};
});
function handleDefaultResult(payload, def) {
	if (payload.value === void 0) payload.value = def.defaultValue;
	return payload;
}
const $ZodPrefault = /* @__PURE__ */ $constructor("$ZodPrefault", (inst, def) => {
	$ZodType.init(inst, def);
	inst._zod.optin = "optional";
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		if (payload.value === void 0) payload.value = def.defaultValue;
		return def.innerType._zod.run(payload, ctx);
	};
});
const $ZodNonOptional = /* @__PURE__ */ $constructor("$ZodNonOptional", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "values", () => {
		const v = def.innerType._zod.values;
		return v ? new Set([...v].filter((x) => x !== void 0)) : void 0;
	});
	inst._zod.parse = (payload, ctx) => {
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => handleNonOptionalResult(result, inst));
		return handleNonOptionalResult(result, inst);
	};
});
function handleNonOptionalResult(payload, inst) {
	if (!payload.issues.length && payload.value === void 0) payload.issues.push({
		code: "invalid_type",
		expected: "nonoptional",
		input: payload.value,
		inst
	});
	return payload;
}
const $ZodCatch = /* @__PURE__ */ $constructor("$ZodCatch", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "optin", () => def.innerType._zod.optin);
	defineLazy(inst._zod, "optout", () => def.innerType._zod.optout);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then((result) => {
			payload.value = result.value;
			if (result.issues.length) {
				payload.value = def.catchValue({
					...payload,
					error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
					input: payload.value
				});
				payload.issues = [];
			}
			return payload;
		});
		payload.value = result.value;
		if (result.issues.length) {
			payload.value = def.catchValue({
				...payload,
				error: { issues: result.issues.map((iss) => finalizeIssue(iss, ctx, config())) },
				input: payload.value
			});
			payload.issues = [];
		}
		return payload;
	};
});
const $ZodPipe = /* @__PURE__ */ $constructor("$ZodPipe", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "values", () => def.in._zod.values);
	defineLazy(inst._zod, "optin", () => def.in._zod.optin);
	defineLazy(inst._zod, "optout", () => def.out._zod.optout);
	defineLazy(inst._zod, "propValues", () => def.in._zod.propValues);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") {
			const right = def.out._zod.run(payload, ctx);
			if (right instanceof Promise) return right.then((right) => handlePipeResult(right, def.in, ctx));
			return handlePipeResult(right, def.in, ctx);
		}
		const left = def.in._zod.run(payload, ctx);
		if (left instanceof Promise) return left.then((left) => handlePipeResult(left, def.out, ctx));
		return handlePipeResult(left, def.out, ctx);
	};
});
function handlePipeResult(left, next, ctx) {
	if (left.issues.length) {
		left.aborted = true;
		return left;
	}
	return next._zod.run({
		value: left.value,
		issues: left.issues
	}, ctx);
}
const $ZodReadonly = /* @__PURE__ */ $constructor("$ZodReadonly", (inst, def) => {
	$ZodType.init(inst, def);
	defineLazy(inst._zod, "propValues", () => def.innerType._zod.propValues);
	defineLazy(inst._zod, "values", () => def.innerType._zod.values);
	defineLazy(inst._zod, "optin", () => def.innerType?._zod?.optin);
	defineLazy(inst._zod, "optout", () => def.innerType?._zod?.optout);
	inst._zod.parse = (payload, ctx) => {
		if (ctx.direction === "backward") return def.innerType._zod.run(payload, ctx);
		const result = def.innerType._zod.run(payload, ctx);
		if (result instanceof Promise) return result.then(handleReadonlyResult);
		return handleReadonlyResult(result);
	};
});
function handleReadonlyResult(payload) {
	payload.value = Object.freeze(payload.value);
	return payload;
}
const $ZodCustom = /* @__PURE__ */ $constructor("$ZodCustom", (inst, def) => {
	$ZodCheck.init(inst, def);
	$ZodType.init(inst, def);
	inst._zod.parse = (payload, _) => {
		return payload;
	};
	inst._zod.check = (payload) => {
		const input = payload.value;
		const r = def.fn(input);
		if (r instanceof Promise) return r.then((r) => handleRefineResult(r, payload, input, inst));
		handleRefineResult(r, payload, input, inst);
	};
});
function handleRefineResult(result, payload, input, inst) {
	if (!result) {
		const _iss = {
			code: "custom",
			input,
			inst,
			path: [...inst._zod.def.path ?? []],
			continue: !inst._zod.def.abort
		};
		if (inst._zod.def.params) _iss.params = inst._zod.def.params;
		payload.issues.push(issue(_iss));
	}
}

//#endregion
//#region ../../node_modules/.pnpm/zod@4.4.1/node_modules/zod/v4/core/registries.js
var _a;
var $ZodRegistry = class {
	constructor() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
	}
	add(schema, ..._meta) {
		const meta = _meta[0];
		this._map.set(schema, meta);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.set(meta.id, schema);
		return this;
	}
	clear() {
		this._map = /* @__PURE__ */ new WeakMap();
		this._idmap = /* @__PURE__ */ new Map();
		return this;
	}
	remove(schema) {
		const meta = this._map.get(schema);
		if (meta && typeof meta === "object" && "id" in meta) this._idmap.delete(meta.id);
		this._map.delete(schema);
		return this;
	}
	get(schema) {
		const p = schema._zod.parent;
		if (p) {
			const pm = { ...this.get(p) ?? {} };
			delete pm.id;
			const f = {
				...pm,
				...this._map.get(schema)
			};
			return Object.keys(f).length ? f : void 0;
		}
		return this._map.get(schema);
	}
	has(schema) {
		return this._map.has(schema);
	}
};
function registry() {
	return new $ZodRegistry();
}
(_a = globalThis).__zod_globalRegistry ?? (_a.__zod_globalRegistry = registry());
const globalRegistry = globalThis.__zod_globalRegistry;

//#endregion
//#region ../../node_modules/.pnpm/zod@4.4.1/node_modules/zod/v4/core/api.js
/* @__NO_SIDE_EFFECTS__ */
function _string(Class, params) {
	return new Class({
		type: "string",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _email(Class, params) {
	return new Class({
		type: "string",
		format: "email",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _guid(Class, params) {
	return new Class({
		type: "string",
		format: "guid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _uuid(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _uuidv4(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v4",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _uuidv6(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v6",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _uuidv7(Class, params) {
	return new Class({
		type: "string",
		format: "uuid",
		check: "string_format",
		abort: false,
		version: "v7",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _url(Class, params) {
	return new Class({
		type: "string",
		format: "url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _emoji(Class, params) {
	return new Class({
		type: "string",
		format: "emoji",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _nanoid(Class, params) {
	return new Class({
		type: "string",
		format: "nanoid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link _cuid2} instead.
* See https://github.com/paralleldrive/cuid.
*/
/* @__NO_SIDE_EFFECTS__ */
function _cuid(Class, params) {
	return new Class({
		type: "string",
		format: "cuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _cuid2(Class, params) {
	return new Class({
		type: "string",
		format: "cuid2",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _ulid(Class, params) {
	return new Class({
		type: "string",
		format: "ulid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _xid(Class, params) {
	return new Class({
		type: "string",
		format: "xid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _ksuid(Class, params) {
	return new Class({
		type: "string",
		format: "ksuid",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _ipv4(Class, params) {
	return new Class({
		type: "string",
		format: "ipv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _ipv6(Class, params) {
	return new Class({
		type: "string",
		format: "ipv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _cidrv4(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv4",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _cidrv6(Class, params) {
	return new Class({
		type: "string",
		format: "cidrv6",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _base64(Class, params) {
	return new Class({
		type: "string",
		format: "base64",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _base64url(Class, params) {
	return new Class({
		type: "string",
		format: "base64url",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _e164(Class, params) {
	return new Class({
		type: "string",
		format: "e164",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _jwt(Class, params) {
	return new Class({
		type: "string",
		format: "jwt",
		check: "string_format",
		abort: false,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _isoDateTime(Class, params) {
	return new Class({
		type: "string",
		format: "datetime",
		check: "string_format",
		offset: false,
		local: false,
		precision: null,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _isoDate(Class, params) {
	return new Class({
		type: "string",
		format: "date",
		check: "string_format",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _isoTime(Class, params) {
	return new Class({
		type: "string",
		format: "time",
		check: "string_format",
		precision: null,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _isoDuration(Class, params) {
	return new Class({
		type: "string",
		format: "duration",
		check: "string_format",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _number(Class, params) {
	return new Class({
		type: "number",
		checks: [],
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _int(Class, params) {
	return new Class({
		type: "number",
		check: "number_format",
		abort: false,
		format: "safeint",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _boolean(Class, params) {
	return new Class({
		type: "boolean",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _unknown(Class) {
	return new Class({ type: "unknown" });
}
/* @__NO_SIDE_EFFECTS__ */
function _never(Class, params) {
	return new Class({
		type: "never",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _lt(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _lte(value, params) {
	return new $ZodCheckLessThan({
		check: "less_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _gt(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: false
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _gte(value, params) {
	return new $ZodCheckGreaterThan({
		check: "greater_than",
		...normalizeParams(params),
		value,
		inclusive: true
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _multipleOf(value, params) {
	return new $ZodCheckMultipleOf({
		check: "multiple_of",
		...normalizeParams(params),
		value
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _maxLength(maximum, params) {
	return new $ZodCheckMaxLength({
		check: "max_length",
		...normalizeParams(params),
		maximum
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _minLength(minimum, params) {
	return new $ZodCheckMinLength({
		check: "min_length",
		...normalizeParams(params),
		minimum
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _length(length, params) {
	return new $ZodCheckLengthEquals({
		check: "length_equals",
		...normalizeParams(params),
		length
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _regex(pattern, params) {
	return new $ZodCheckRegex({
		check: "string_format",
		format: "regex",
		...normalizeParams(params),
		pattern
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _lowercase(params) {
	return new $ZodCheckLowerCase({
		check: "string_format",
		format: "lowercase",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _uppercase(params) {
	return new $ZodCheckUpperCase({
		check: "string_format",
		format: "uppercase",
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _includes(includes, params) {
	return new $ZodCheckIncludes({
		check: "string_format",
		format: "includes",
		...normalizeParams(params),
		includes
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _startsWith(prefix, params) {
	return new $ZodCheckStartsWith({
		check: "string_format",
		format: "starts_with",
		...normalizeParams(params),
		prefix
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _endsWith(suffix, params) {
	return new $ZodCheckEndsWith({
		check: "string_format",
		format: "ends_with",
		...normalizeParams(params),
		suffix
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _overwrite(tx) {
	return new $ZodCheckOverwrite({
		check: "overwrite",
		tx
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _normalize(form) {
	return /* @__PURE__ */ _overwrite((input) => input.normalize(form));
}
/* @__NO_SIDE_EFFECTS__ */
function _trim() {
	return /* @__PURE__ */ _overwrite((input) => input.trim());
}
/* @__NO_SIDE_EFFECTS__ */
function _toLowerCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toLowerCase());
}
/* @__NO_SIDE_EFFECTS__ */
function _toUpperCase() {
	return /* @__PURE__ */ _overwrite((input) => input.toUpperCase());
}
/* @__NO_SIDE_EFFECTS__ */
function _slugify() {
	return /* @__PURE__ */ _overwrite((input) => slugify(input));
}
/* @__NO_SIDE_EFFECTS__ */
function _array(Class, element, params) {
	return new Class({
		type: "array",
		element,
		...normalizeParams(params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _refine(Class, fn, _params) {
	return new Class({
		type: "custom",
		check: "custom",
		fn,
		...normalizeParams(_params)
	});
}
/* @__NO_SIDE_EFFECTS__ */
function _superRefine(fn, params) {
	const ch = /* @__PURE__ */ _check((payload) => {
		payload.addIssue = (issue$2) => {
			if (typeof issue$2 === "string") payload.issues.push(issue(issue$2, payload.value, ch._zod.def));
			else {
				const _issue = issue$2;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				_issue.input ?? (_issue.input = payload.value);
				_issue.inst ?? (_issue.inst = ch);
				_issue.continue ?? (_issue.continue = !ch._zod.def.abort);
				payload.issues.push(issue(_issue));
			}
		};
		return fn(payload.value, payload);
	}, params);
	return ch;
}
/* @__NO_SIDE_EFFECTS__ */
function _check(fn, params) {
	const ch = new $ZodCheck({
		check: "custom",
		...normalizeParams(params)
	});
	ch._zod.check = fn;
	return ch;
}
/* @__NO_SIDE_EFFECTS__ */
function describe$1(description) {
	const ch = new $ZodCheck({ check: "describe" });
	ch._zod.onattach = [(inst) => {
		const existing = globalRegistry.get(inst) ?? {};
		globalRegistry.add(inst, {
			...existing,
			description
		});
	}];
	ch._zod.check = () => {};
	return ch;
}
/* @__NO_SIDE_EFFECTS__ */
function meta$1(metadata) {
	const ch = new $ZodCheck({ check: "meta" });
	ch._zod.onattach = [(inst) => {
		const existing = globalRegistry.get(inst) ?? {};
		globalRegistry.add(inst, {
			...existing,
			...metadata
		});
	}];
	ch._zod.check = () => {};
	return ch;
}

//#endregion
//#region ../../node_modules/.pnpm/zod@4.4.1/node_modules/zod/v4/core/to-json-schema.js
function initializeContext(params) {
	let target = params?.target ?? "draft-2020-12";
	if (target === "draft-4") target = "draft-04";
	if (target === "draft-7") target = "draft-07";
	return {
		processors: params.processors ?? {},
		metadataRegistry: params?.metadata ?? globalRegistry,
		target,
		unrepresentable: params?.unrepresentable ?? "throw",
		override: params?.override ?? (() => {}),
		io: params?.io ?? "output",
		counter: 0,
		seen: /* @__PURE__ */ new Map(),
		cycles: params?.cycles ?? "ref",
		reused: params?.reused ?? "inline",
		external: params?.external ?? void 0
	};
}
function process$1(schema, ctx, _params = {
	path: [],
	schemaPath: []
}) {
	var _a;
	const def = schema._zod.def;
	const seen = ctx.seen.get(schema);
	if (seen) {
		seen.count++;
		if (_params.schemaPath.includes(schema)) seen.cycle = _params.path;
		return seen.schema;
	}
	const result = {
		schema: {},
		count: 1,
		cycle: void 0,
		path: _params.path
	};
	ctx.seen.set(schema, result);
	const overrideSchema = schema._zod.toJSONSchema?.();
	if (overrideSchema) result.schema = overrideSchema;
	else {
		const params = {
			..._params,
			schemaPath: [..._params.schemaPath, schema],
			path: _params.path
		};
		if (schema._zod.processJSONSchema) schema._zod.processJSONSchema(ctx, result.schema, params);
		else {
			const _json = result.schema;
			const processor = ctx.processors[def.type];
			if (!processor) throw new Error(`[toJSONSchema]: Non-representable type encountered: ${def.type}`);
			processor(schema, ctx, _json, params);
		}
		const parent = schema._zod.parent;
		if (parent) {
			if (!result.ref) result.ref = parent;
			process$1(parent, ctx, params);
			ctx.seen.get(parent).isParent = true;
		}
	}
	const meta = ctx.metadataRegistry.get(schema);
	if (meta) Object.assign(result.schema, meta);
	if (ctx.io === "input" && isTransforming(schema)) {
		delete result.schema.examples;
		delete result.schema.default;
	}
	if (ctx.io === "input" && "_prefault" in result.schema) (_a = result.schema).default ?? (_a.default = result.schema._prefault);
	delete result.schema._prefault;
	return ctx.seen.get(schema).schema;
}
function extractDefs(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const idToSchema = /* @__PURE__ */ new Map();
	for (const entry of ctx.seen.entries()) {
		const id = ctx.metadataRegistry.get(entry[0])?.id;
		if (id) {
			const existing = idToSchema.get(id);
			if (existing && existing !== entry[0]) throw new Error(`Duplicate schema id "${id}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);
			idToSchema.set(id, entry[0]);
		}
	}
	const makeURI = (entry) => {
		const defsSegment = ctx.target === "draft-2020-12" ? "$defs" : "definitions";
		if (ctx.external) {
			const externalId = ctx.external.registry.get(entry[0])?.id;
			const uriGenerator = ctx.external.uri ?? ((id) => id);
			if (externalId) return { ref: uriGenerator(externalId) };
			const id = entry[1].defId ?? entry[1].schema.id ?? `schema${ctx.counter++}`;
			entry[1].defId = id;
			return {
				defId: id,
				ref: `${uriGenerator("__shared")}#/${defsSegment}/${id}`
			};
		}
		if (entry[1] === root) return { ref: "#" };
		const defUriPrefix = `#/${defsSegment}/`;
		const defId = entry[1].schema.id ?? `__schema${ctx.counter++}`;
		return {
			defId,
			ref: defUriPrefix + defId
		};
	};
	const extractToDef = (entry) => {
		if (entry[1].schema.$ref) return;
		const seen = entry[1];
		const { ref, defId } = makeURI(entry);
		seen.def = { ...seen.schema };
		if (defId) seen.defId = defId;
		const schema = seen.schema;
		for (const key in schema) delete schema[key];
		schema.$ref = ref;
	};
	if (ctx.cycles === "throw") for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.cycle) throw new Error(`Cycle detected: #/${seen.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`);
	}
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (schema === entry[0]) {
			extractToDef(entry);
			continue;
		}
		if (ctx.external) {
			const ext = ctx.external.registry.get(entry[0])?.id;
			if (schema !== entry[0] && ext) {
				extractToDef(entry);
				continue;
			}
		}
		if (ctx.metadataRegistry.get(entry[0])?.id) {
			extractToDef(entry);
			continue;
		}
		if (seen.cycle) {
			extractToDef(entry);
			continue;
		}
		if (seen.count > 1) {
			if (ctx.reused === "ref") {
				extractToDef(entry);
				continue;
			}
		}
	}
}
function finalize(ctx, schema) {
	const root = ctx.seen.get(schema);
	if (!root) throw new Error("Unprocessed schema. This is a bug in Zod.");
	const flattenRef = (zodSchema) => {
		const seen = ctx.seen.get(zodSchema);
		if (seen.ref === null) return;
		const schema = seen.def ?? seen.schema;
		const _cached = { ...schema };
		const ref = seen.ref;
		seen.ref = null;
		if (ref) {
			flattenRef(ref);
			const refSeen = ctx.seen.get(ref);
			const refSchema = refSeen.schema;
			if (refSchema.$ref && (ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0")) {
				schema.allOf = schema.allOf ?? [];
				schema.allOf.push(refSchema);
			} else Object.assign(schema, refSchema);
			Object.assign(schema, _cached);
			if (zodSchema._zod.parent === ref) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (!(key in _cached)) delete schema[key];
			}
			if (refSchema.$ref && refSeen.def) for (const key in schema) {
				if (key === "$ref" || key === "allOf") continue;
				if (key in refSeen.def && JSON.stringify(schema[key]) === JSON.stringify(refSeen.def[key])) delete schema[key];
			}
		}
		const parent = zodSchema._zod.parent;
		if (parent && parent !== ref) {
			flattenRef(parent);
			const parentSeen = ctx.seen.get(parent);
			if (parentSeen?.schema.$ref) {
				schema.$ref = parentSeen.schema.$ref;
				if (parentSeen.def) for (const key in schema) {
					if (key === "$ref" || key === "allOf") continue;
					if (key in parentSeen.def && JSON.stringify(schema[key]) === JSON.stringify(parentSeen.def[key])) delete schema[key];
				}
			}
		}
		ctx.override({
			zodSchema,
			jsonSchema: schema,
			path: seen.path ?? []
		});
	};
	for (const entry of [...ctx.seen.entries()].reverse()) flattenRef(entry[0]);
	const result = {};
	if (ctx.target === "draft-2020-12") result.$schema = "https://json-schema.org/draft/2020-12/schema";
	else if (ctx.target === "draft-07") result.$schema = "http://json-schema.org/draft-07/schema#";
	else if (ctx.target === "draft-04") result.$schema = "http://json-schema.org/draft-04/schema#";
	else if (ctx.target === "openapi-3.0") {}
	if (ctx.external?.uri) {
		const id = ctx.external.registry.get(schema)?.id;
		if (!id) throw new Error("Schema is missing an `id` property");
		result.$id = ctx.external.uri(id);
	}
	Object.assign(result, root.def ?? root.schema);
	const rootMetaId = ctx.metadataRegistry.get(schema)?.id;
	if (rootMetaId !== void 0 && result.id === rootMetaId) delete result.id;
	const defs = ctx.external?.defs ?? {};
	for (const entry of ctx.seen.entries()) {
		const seen = entry[1];
		if (seen.def && seen.defId) {
			if (seen.def.id === seen.defId) delete seen.def.id;
			defs[seen.defId] = seen.def;
		}
	}
	if (ctx.external) {} else if (Object.keys(defs).length > 0) if (ctx.target === "draft-2020-12") result.$defs = defs;
	else result.definitions = defs;
	try {
		const finalized = JSON.parse(JSON.stringify(result));
		Object.defineProperty(finalized, "~standard", {
			value: {
				...schema["~standard"],
				jsonSchema: {
					input: createStandardJSONSchemaMethod(schema, "input", ctx.processors),
					output: createStandardJSONSchemaMethod(schema, "output", ctx.processors)
				}
			},
			enumerable: false,
			writable: false
		});
		return finalized;
	} catch (_err) {
		throw new Error("Error converting schema to JSON.");
	}
}
function isTransforming(_schema, _ctx) {
	const ctx = _ctx ?? { seen: /* @__PURE__ */ new Set() };
	if (ctx.seen.has(_schema)) return false;
	ctx.seen.add(_schema);
	const def = _schema._zod.def;
	if (def.type === "transform") return true;
	if (def.type === "array") return isTransforming(def.element, ctx);
	if (def.type === "set") return isTransforming(def.valueType, ctx);
	if (def.type === "lazy") return isTransforming(def.getter(), ctx);
	if (def.type === "promise" || def.type === "optional" || def.type === "nonoptional" || def.type === "nullable" || def.type === "readonly" || def.type === "default" || def.type === "prefault") return isTransforming(def.innerType, ctx);
	if (def.type === "intersection") return isTransforming(def.left, ctx) || isTransforming(def.right, ctx);
	if (def.type === "record" || def.type === "map") return isTransforming(def.keyType, ctx) || isTransforming(def.valueType, ctx);
	if (def.type === "pipe") return isTransforming(def.in, ctx) || isTransforming(def.out, ctx);
	if (def.type === "object") {
		for (const key in def.shape) if (isTransforming(def.shape[key], ctx)) return true;
		return false;
	}
	if (def.type === "union") {
		for (const option of def.options) if (isTransforming(option, ctx)) return true;
		return false;
	}
	if (def.type === "tuple") {
		for (const item of def.items) if (isTransforming(item, ctx)) return true;
		if (def.rest && isTransforming(def.rest, ctx)) return true;
		return false;
	}
	return false;
}
/**
* Creates a toJSONSchema method for a schema instance.
* This encapsulates the logic of initializing context, processing, extracting defs, and finalizing.
*/
const createToJSONSchemaMethod = (schema, processors = {}) => (params) => {
	const ctx = initializeContext({
		...params,
		processors
	});
	process$1(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};
const createStandardJSONSchemaMethod = (schema, io, processors = {}) => (params) => {
	const { libraryOptions, target } = params ?? {};
	const ctx = initializeContext({
		...libraryOptions ?? {},
		target,
		io,
		processors
	});
	process$1(schema, ctx);
	extractDefs(ctx, schema);
	return finalize(ctx, schema);
};

//#endregion
//#region ../../node_modules/.pnpm/zod@4.4.1/node_modules/zod/v4/core/json-schema-processors.js
const formatMap = {
	guid: "uuid",
	url: "uri",
	datetime: "date-time",
	json_string: "json-string",
	regex: ""
};
const stringProcessor = (schema, ctx, _json, _params) => {
	const json = _json;
	json.type = "string";
	const { minimum, maximum, format, patterns, contentEncoding } = schema._zod.bag;
	if (typeof minimum === "number") json.minLength = minimum;
	if (typeof maximum === "number") json.maxLength = maximum;
	if (format) {
		json.format = formatMap[format] ?? format;
		if (json.format === "") delete json.format;
		if (format === "time") delete json.format;
	}
	if (contentEncoding) json.contentEncoding = contentEncoding;
	if (patterns && patterns.size > 0) {
		const regexes = [...patterns];
		if (regexes.length === 1) json.pattern = regexes[0].source;
		else if (regexes.length > 1) json.allOf = [...regexes.map((regex) => ({
			...ctx.target === "draft-07" || ctx.target === "draft-04" || ctx.target === "openapi-3.0" ? { type: "string" } : {},
			pattern: regex.source
		}))];
	}
};
const numberProcessor = (schema, ctx, _json, _params) => {
	const json = _json;
	const { minimum, maximum, format, multipleOf, exclusiveMaximum, exclusiveMinimum } = schema._zod.bag;
	if (typeof format === "string" && format.includes("int")) json.type = "integer";
	else json.type = "number";
	const exMin = typeof exclusiveMinimum === "number" && exclusiveMinimum >= (minimum ?? Number.NEGATIVE_INFINITY);
	const exMax = typeof exclusiveMaximum === "number" && exclusiveMaximum <= (maximum ?? Number.POSITIVE_INFINITY);
	const legacy = ctx.target === "draft-04" || ctx.target === "openapi-3.0";
	if (exMin) if (legacy) {
		json.minimum = exclusiveMinimum;
		json.exclusiveMinimum = true;
	} else json.exclusiveMinimum = exclusiveMinimum;
	else if (typeof minimum === "number") json.minimum = minimum;
	if (exMax) if (legacy) {
		json.maximum = exclusiveMaximum;
		json.exclusiveMaximum = true;
	} else json.exclusiveMaximum = exclusiveMaximum;
	else if (typeof maximum === "number") json.maximum = maximum;
	if (typeof multipleOf === "number") json.multipleOf = multipleOf;
};
const booleanProcessor = (_schema, _ctx, json, _params) => {
	json.type = "boolean";
};
const neverProcessor = (_schema, _ctx, json, _params) => {
	json.not = {};
};
const unknownProcessor = (_schema, _ctx, _json, _params) => {};
const enumProcessor = (schema, _ctx, json, _params) => {
	const def = schema._zod.def;
	const values = getEnumValues(def.entries);
	if (values.every((v) => typeof v === "number")) json.type = "number";
	if (values.every((v) => typeof v === "string")) json.type = "string";
	json.enum = values;
};
const literalProcessor = (schema, ctx, json, _params) => {
	const def = schema._zod.def;
	const vals = [];
	for (const val of def.values) if (val === void 0) {
		if (ctx.unrepresentable === "throw") throw new Error("Literal `undefined` cannot be represented in JSON Schema");
	} else if (typeof val === "bigint") if (ctx.unrepresentable === "throw") throw new Error("BigInt literals cannot be represented in JSON Schema");
	else vals.push(Number(val));
	else vals.push(val);
	if (vals.length === 0) {} else if (vals.length === 1) {
		const val = vals[0];
		json.type = val === null ? "null" : typeof val;
		if (ctx.target === "draft-04" || ctx.target === "openapi-3.0") json.enum = [val];
		else json.const = val;
	} else {
		if (vals.every((v) => typeof v === "number")) json.type = "number";
		if (vals.every((v) => typeof v === "string")) json.type = "string";
		if (vals.every((v) => typeof v === "boolean")) json.type = "boolean";
		if (vals.every((v) => v === null)) json.type = "null";
		json.enum = vals;
	}
};
const customProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Custom types cannot be represented in JSON Schema");
};
const transformProcessor = (_schema, ctx, _json, _params) => {
	if (ctx.unrepresentable === "throw") throw new Error("Transforms cannot be represented in JSON Schema");
};
const arrayProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	const { minimum, maximum } = schema._zod.bag;
	if (typeof minimum === "number") json.minItems = minimum;
	if (typeof maximum === "number") json.maxItems = maximum;
	json.type = "array";
	json.items = process$1(def.element, ctx, {
		...params,
		path: [...params.path, "items"]
	});
};
const objectProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	json.type = "object";
	json.properties = {};
	const shape = def.shape;
	for (const key in shape) json.properties[key] = process$1(shape[key], ctx, {
		...params,
		path: [
			...params.path,
			"properties",
			key
		]
	});
	const allKeys = new Set(Object.keys(shape));
	const requiredKeys = new Set([...allKeys].filter((key) => {
		const v = def.shape[key]._zod;
		if (ctx.io === "input") return v.optin === void 0;
		else return v.optout === void 0;
	}));
	if (requiredKeys.size > 0) json.required = Array.from(requiredKeys);
	if (def.catchall?._zod.def.type === "never") json.additionalProperties = false;
	else if (!def.catchall) {
		if (ctx.io === "output") json.additionalProperties = false;
	} else if (def.catchall) json.additionalProperties = process$1(def.catchall, ctx, {
		...params,
		path: [...params.path, "additionalProperties"]
	});
};
const unionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const isExclusive = def.inclusive === false;
	const options = def.options.map((x, i) => process$1(x, ctx, {
		...params,
		path: [
			...params.path,
			isExclusive ? "oneOf" : "anyOf",
			i
		]
	}));
	if (isExclusive) json.oneOf = options;
	else json.anyOf = options;
};
const intersectionProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const a = process$1(def.left, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			0
		]
	});
	const b = process$1(def.right, ctx, {
		...params,
		path: [
			...params.path,
			"allOf",
			1
		]
	});
	const isSimpleIntersection = (val) => "allOf" in val && Object.keys(val).length === 1;
	json.allOf = [...isSimpleIntersection(a) ? a.allOf : [a], ...isSimpleIntersection(b) ? b.allOf : [b]];
};
const recordProcessor = (schema, ctx, _json, params) => {
	const json = _json;
	const def = schema._zod.def;
	json.type = "object";
	const keyType = def.keyType;
	const patterns = keyType._zod.bag?.patterns;
	if (def.mode === "loose" && patterns && patterns.size > 0) {
		const valueSchema = process$1(def.valueType, ctx, {
			...params,
			path: [
				...params.path,
				"patternProperties",
				"*"
			]
		});
		json.patternProperties = {};
		for (const pattern of patterns) json.patternProperties[pattern.source] = valueSchema;
	} else {
		if (ctx.target === "draft-07" || ctx.target === "draft-2020-12") json.propertyNames = process$1(def.keyType, ctx, {
			...params,
			path: [...params.path, "propertyNames"]
		});
		json.additionalProperties = process$1(def.valueType, ctx, {
			...params,
			path: [...params.path, "additionalProperties"]
		});
	}
	const keyValues = keyType._zod.values;
	if (keyValues) {
		const validKeyValues = [...keyValues].filter((v) => typeof v === "string" || typeof v === "number");
		if (validKeyValues.length > 0) json.required = validKeyValues;
	}
};
const nullableProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	const inner = process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	if (ctx.target === "openapi-3.0") {
		seen.ref = def.innerType;
		json.nullable = true;
	} else json.anyOf = [inner, { type: "null" }];
};
const nonoptionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};
const defaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	json.default = JSON.parse(JSON.stringify(def.defaultValue));
};
const prefaultProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	if (ctx.io === "input") json._prefault = JSON.parse(JSON.stringify(def.defaultValue));
};
const catchProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	let catchValue;
	try {
		catchValue = def.catchValue(void 0);
	} catch {
		throw new Error("Dynamic catch values are not supported in JSON Schema");
	}
	json.default = catchValue;
};
const pipeProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	const innerType = ctx.io === "input" ? def.in._zod.def.type === "transform" ? def.out : def.in : def.out;
	process$1(innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = innerType;
};
const readonlyProcessor = (schema, ctx, json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
	json.readOnly = true;
};
const optionalProcessor = (schema, ctx, _json, params) => {
	const def = schema._zod.def;
	process$1(def.innerType, ctx, params);
	const seen = ctx.seen.get(schema);
	seen.ref = def.innerType;
};

//#endregion
//#region ../../node_modules/.pnpm/zod@4.4.1/node_modules/zod/v4/classic/iso.js
const ZodISODateTime = /* @__PURE__ */ $constructor("ZodISODateTime", (inst, def) => {
	$ZodISODateTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function datetime(params) {
	return _isoDateTime(ZodISODateTime, params);
}
const ZodISODate = /* @__PURE__ */ $constructor("ZodISODate", (inst, def) => {
	$ZodISODate.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function date(params) {
	return _isoDate(ZodISODate, params);
}
const ZodISOTime = /* @__PURE__ */ $constructor("ZodISOTime", (inst, def) => {
	$ZodISOTime.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function time(params) {
	return _isoTime(ZodISOTime, params);
}
const ZodISODuration = /* @__PURE__ */ $constructor("ZodISODuration", (inst, def) => {
	$ZodISODuration.init(inst, def);
	ZodStringFormat.init(inst, def);
});
function duration(params) {
	return _isoDuration(ZodISODuration, params);
}

//#endregion
//#region ../../node_modules/.pnpm/zod@4.4.1/node_modules/zod/v4/classic/errors.js
const initializer = (inst, issues) => {
	$ZodError.init(inst, issues);
	inst.name = "ZodError";
	Object.defineProperties(inst, {
		format: { value: (mapper) => formatError(inst, mapper) },
		flatten: { value: (mapper) => flattenError(inst, mapper) },
		addIssue: { value: (issue) => {
			inst.issues.push(issue);
			inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
		} },
		addIssues: { value: (issues) => {
			inst.issues.push(...issues);
			inst.message = JSON.stringify(inst.issues, jsonStringifyReplacer, 2);
		} },
		isEmpty: { get() {
			return inst.issues.length === 0;
		} }
	});
};
const ZodRealError = /* @__PURE__ */ $constructor("ZodError", initializer, { Parent: Error });

//#endregion
//#region ../../node_modules/.pnpm/zod@4.4.1/node_modules/zod/v4/classic/parse.js
const parse = /* @__PURE__ */ _parse(ZodRealError);
const parseAsync = /* @__PURE__ */ _parseAsync(ZodRealError);
const safeParse = /* @__PURE__ */ _safeParse(ZodRealError);
const safeParseAsync = /* @__PURE__ */ _safeParseAsync(ZodRealError);
const encode = /* @__PURE__ */ _encode(ZodRealError);
const decode = /* @__PURE__ */ _decode(ZodRealError);
const encodeAsync = /* @__PURE__ */ _encodeAsync(ZodRealError);
const decodeAsync = /* @__PURE__ */ _decodeAsync(ZodRealError);
const safeEncode = /* @__PURE__ */ _safeEncode(ZodRealError);
const safeDecode = /* @__PURE__ */ _safeDecode(ZodRealError);
const safeEncodeAsync = /* @__PURE__ */ _safeEncodeAsync(ZodRealError);
const safeDecodeAsync = /* @__PURE__ */ _safeDecodeAsync(ZodRealError);

//#endregion
//#region ../../node_modules/.pnpm/zod@4.4.1/node_modules/zod/v4/classic/schemas.js
const _installedGroups = /* @__PURE__ */ new WeakMap();
function _installLazyMethods(inst, group, methods) {
	const proto = Object.getPrototypeOf(inst);
	let installed = _installedGroups.get(proto);
	if (!installed) {
		installed = /* @__PURE__ */ new Set();
		_installedGroups.set(proto, installed);
	}
	if (installed.has(group)) return;
	installed.add(group);
	for (const key in methods) {
		const fn = methods[key];
		Object.defineProperty(proto, key, {
			configurable: true,
			enumerable: false,
			get() {
				const bound = fn.bind(this);
				Object.defineProperty(this, key, {
					configurable: true,
					writable: true,
					enumerable: true,
					value: bound
				});
				return bound;
			},
			set(v) {
				Object.defineProperty(this, key, {
					configurable: true,
					writable: true,
					enumerable: true,
					value: v
				});
			}
		});
	}
}
const ZodType = /* @__PURE__ */ $constructor("ZodType", (inst, def) => {
	$ZodType.init(inst, def);
	Object.assign(inst["~standard"], { jsonSchema: {
		input: createStandardJSONSchemaMethod(inst, "input"),
		output: createStandardJSONSchemaMethod(inst, "output")
	} });
	inst.toJSONSchema = createToJSONSchemaMethod(inst, {});
	inst.def = def;
	inst.type = def.type;
	Object.defineProperty(inst, "_def", { value: def });
	inst.parse = (data, params) => parse(inst, data, params, { callee: inst.parse });
	inst.safeParse = (data, params) => safeParse(inst, data, params);
	inst.parseAsync = async (data, params) => parseAsync(inst, data, params, { callee: inst.parseAsync });
	inst.safeParseAsync = async (data, params) => safeParseAsync(inst, data, params);
	inst.spa = inst.safeParseAsync;
	inst.encode = (data, params) => encode(inst, data, params);
	inst.decode = (data, params) => decode(inst, data, params);
	inst.encodeAsync = async (data, params) => encodeAsync(inst, data, params);
	inst.decodeAsync = async (data, params) => decodeAsync(inst, data, params);
	inst.safeEncode = (data, params) => safeEncode(inst, data, params);
	inst.safeDecode = (data, params) => safeDecode(inst, data, params);
	inst.safeEncodeAsync = async (data, params) => safeEncodeAsync(inst, data, params);
	inst.safeDecodeAsync = async (data, params) => safeDecodeAsync(inst, data, params);
	_installLazyMethods(inst, "ZodType", {
		check(...chks) {
			const def = this.def;
			return this.clone(mergeDefs(def, { checks: [...def.checks ?? [], ...chks.map((ch) => typeof ch === "function" ? { _zod: {
				check: ch,
				def: { check: "custom" },
				onattach: []
			} } : ch)] }), { parent: true });
		},
		with(...chks) {
			return this.check(...chks);
		},
		clone(def, params) {
			return clone(this, def, params);
		},
		brand() {
			return this;
		},
		register(reg, meta) {
			reg.add(this, meta);
			return this;
		},
		refine(check, params) {
			return this.check(refine(check, params));
		},
		superRefine(refinement, params) {
			return this.check(superRefine(refinement, params));
		},
		overwrite(fn) {
			return this.check(_overwrite(fn));
		},
		optional() {
			return optional(this);
		},
		exactOptional() {
			return exactOptional(this);
		},
		nullable() {
			return nullable(this);
		},
		nullish() {
			return optional(nullable(this));
		},
		nonoptional(params) {
			return nonoptional(this, params);
		},
		array() {
			return array(this);
		},
		or(arg) {
			return union([this, arg]);
		},
		and(arg) {
			return intersection(this, arg);
		},
		transform(tx) {
			return pipe(this, transform(tx));
		},
		default(d) {
			return _default(this, d);
		},
		prefault(d) {
			return prefault(this, d);
		},
		catch(params) {
			return _catch(this, params);
		},
		pipe(target) {
			return pipe(this, target);
		},
		readonly() {
			return readonly(this);
		},
		describe(description) {
			const cl = this.clone();
			globalRegistry.add(cl, { description });
			return cl;
		},
		meta(...args) {
			if (args.length === 0) return globalRegistry.get(this);
			const cl = this.clone();
			globalRegistry.add(cl, args[0]);
			return cl;
		},
		isOptional() {
			return this.safeParse(void 0).success;
		},
		isNullable() {
			return this.safeParse(null).success;
		},
		apply(fn) {
			return fn(this);
		}
	});
	Object.defineProperty(inst, "description", {
		get() {
			return globalRegistry.get(inst)?.description;
		},
		configurable: true
	});
	return inst;
});
/** @internal */
const _ZodString = /* @__PURE__ */ $constructor("_ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => stringProcessor(inst, ctx, json, params);
	const bag = inst._zod.bag;
	inst.format = bag.format ?? null;
	inst.minLength = bag.minimum ?? null;
	inst.maxLength = bag.maximum ?? null;
	_installLazyMethods(inst, "_ZodString", {
		regex(...args) {
			return this.check(_regex(...args));
		},
		includes(...args) {
			return this.check(_includes(...args));
		},
		startsWith(...args) {
			return this.check(_startsWith(...args));
		},
		endsWith(...args) {
			return this.check(_endsWith(...args));
		},
		min(...args) {
			return this.check(_minLength(...args));
		},
		max(...args) {
			return this.check(_maxLength(...args));
		},
		length(...args) {
			return this.check(_length(...args));
		},
		nonempty(...args) {
			return this.check(_minLength(1, ...args));
		},
		lowercase(params) {
			return this.check(_lowercase(params));
		},
		uppercase(params) {
			return this.check(_uppercase(params));
		},
		trim() {
			return this.check(_trim());
		},
		normalize(...args) {
			return this.check(_normalize(...args));
		},
		toLowerCase() {
			return this.check(_toLowerCase());
		},
		toUpperCase() {
			return this.check(_toUpperCase());
		},
		slugify() {
			return this.check(_slugify());
		}
	});
});
const ZodString = /* @__PURE__ */ $constructor("ZodString", (inst, def) => {
	$ZodString.init(inst, def);
	_ZodString.init(inst, def);
	inst.email = (params) => inst.check(_email(ZodEmail, params));
	inst.url = (params) => inst.check(_url(ZodURL, params));
	inst.jwt = (params) => inst.check(_jwt(ZodJWT, params));
	inst.emoji = (params) => inst.check(_emoji(ZodEmoji, params));
	inst.guid = (params) => inst.check(_guid(ZodGUID, params));
	inst.uuid = (params) => inst.check(_uuid(ZodUUID, params));
	inst.uuidv4 = (params) => inst.check(_uuidv4(ZodUUID, params));
	inst.uuidv6 = (params) => inst.check(_uuidv6(ZodUUID, params));
	inst.uuidv7 = (params) => inst.check(_uuidv7(ZodUUID, params));
	inst.nanoid = (params) => inst.check(_nanoid(ZodNanoID, params));
	inst.guid = (params) => inst.check(_guid(ZodGUID, params));
	inst.cuid = (params) => inst.check(_cuid(ZodCUID, params));
	inst.cuid2 = (params) => inst.check(_cuid2(ZodCUID2, params));
	inst.ulid = (params) => inst.check(_ulid(ZodULID, params));
	inst.base64 = (params) => inst.check(_base64(ZodBase64, params));
	inst.base64url = (params) => inst.check(_base64url(ZodBase64URL, params));
	inst.xid = (params) => inst.check(_xid(ZodXID, params));
	inst.ksuid = (params) => inst.check(_ksuid(ZodKSUID, params));
	inst.ipv4 = (params) => inst.check(_ipv4(ZodIPv4, params));
	inst.ipv6 = (params) => inst.check(_ipv6(ZodIPv6, params));
	inst.cidrv4 = (params) => inst.check(_cidrv4(ZodCIDRv4, params));
	inst.cidrv6 = (params) => inst.check(_cidrv6(ZodCIDRv6, params));
	inst.e164 = (params) => inst.check(_e164(ZodE164, params));
	inst.datetime = (params) => inst.check(datetime(params));
	inst.date = (params) => inst.check(date(params));
	inst.time = (params) => inst.check(time(params));
	inst.duration = (params) => inst.check(duration(params));
});
function string(params) {
	return _string(ZodString, params);
}
const ZodStringFormat = /* @__PURE__ */ $constructor("ZodStringFormat", (inst, def) => {
	$ZodStringFormat.init(inst, def);
	_ZodString.init(inst, def);
});
const ZodEmail = /* @__PURE__ */ $constructor("ZodEmail", (inst, def) => {
	$ZodEmail.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodGUID = /* @__PURE__ */ $constructor("ZodGUID", (inst, def) => {
	$ZodGUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodUUID = /* @__PURE__ */ $constructor("ZodUUID", (inst, def) => {
	$ZodUUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodURL = /* @__PURE__ */ $constructor("ZodURL", (inst, def) => {
	$ZodURL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodEmoji = /* @__PURE__ */ $constructor("ZodEmoji", (inst, def) => {
	$ZodEmoji.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodNanoID = /* @__PURE__ */ $constructor("ZodNanoID", (inst, def) => {
	$ZodNanoID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
/**
* @deprecated CUID v1 is deprecated by its authors due to information leakage
* (timestamps embedded in the id). Use {@link ZodCUID2} instead.
* See https://github.com/paralleldrive/cuid.
*/
const ZodCUID = /* @__PURE__ */ $constructor("ZodCUID", (inst, def) => {
	$ZodCUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCUID2 = /* @__PURE__ */ $constructor("ZodCUID2", (inst, def) => {
	$ZodCUID2.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodULID = /* @__PURE__ */ $constructor("ZodULID", (inst, def) => {
	$ZodULID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodXID = /* @__PURE__ */ $constructor("ZodXID", (inst, def) => {
	$ZodXID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodKSUID = /* @__PURE__ */ $constructor("ZodKSUID", (inst, def) => {
	$ZodKSUID.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodIPv4 = /* @__PURE__ */ $constructor("ZodIPv4", (inst, def) => {
	$ZodIPv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodIPv6 = /* @__PURE__ */ $constructor("ZodIPv6", (inst, def) => {
	$ZodIPv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCIDRv4 = /* @__PURE__ */ $constructor("ZodCIDRv4", (inst, def) => {
	$ZodCIDRv4.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodCIDRv6 = /* @__PURE__ */ $constructor("ZodCIDRv6", (inst, def) => {
	$ZodCIDRv6.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodBase64 = /* @__PURE__ */ $constructor("ZodBase64", (inst, def) => {
	$ZodBase64.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodBase64URL = /* @__PURE__ */ $constructor("ZodBase64URL", (inst, def) => {
	$ZodBase64URL.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodE164 = /* @__PURE__ */ $constructor("ZodE164", (inst, def) => {
	$ZodE164.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodJWT = /* @__PURE__ */ $constructor("ZodJWT", (inst, def) => {
	$ZodJWT.init(inst, def);
	ZodStringFormat.init(inst, def);
});
const ZodNumber = /* @__PURE__ */ $constructor("ZodNumber", (inst, def) => {
	$ZodNumber.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => numberProcessor(inst, ctx, json, params);
	_installLazyMethods(inst, "ZodNumber", {
		gt(value, params) {
			return this.check(_gt(value, params));
		},
		gte(value, params) {
			return this.check(_gte(value, params));
		},
		min(value, params) {
			return this.check(_gte(value, params));
		},
		lt(value, params) {
			return this.check(_lt(value, params));
		},
		lte(value, params) {
			return this.check(_lte(value, params));
		},
		max(value, params) {
			return this.check(_lte(value, params));
		},
		int(params) {
			return this.check(int(params));
		},
		safe(params) {
			return this.check(int(params));
		},
		positive(params) {
			return this.check(_gt(0, params));
		},
		nonnegative(params) {
			return this.check(_gte(0, params));
		},
		negative(params) {
			return this.check(_lt(0, params));
		},
		nonpositive(params) {
			return this.check(_lte(0, params));
		},
		multipleOf(value, params) {
			return this.check(_multipleOf(value, params));
		},
		step(value, params) {
			return this.check(_multipleOf(value, params));
		},
		finite() {
			return this;
		}
	});
	const bag = inst._zod.bag;
	inst.minValue = Math.max(bag.minimum ?? Number.NEGATIVE_INFINITY, bag.exclusiveMinimum ?? Number.NEGATIVE_INFINITY) ?? null;
	inst.maxValue = Math.min(bag.maximum ?? Number.POSITIVE_INFINITY, bag.exclusiveMaximum ?? Number.POSITIVE_INFINITY) ?? null;
	inst.isInt = (bag.format ?? "").includes("int") || Number.isSafeInteger(bag.multipleOf ?? .5);
	inst.isFinite = true;
	inst.format = bag.format ?? null;
});
function number(params) {
	return _number(ZodNumber, params);
}
const ZodNumberFormat = /* @__PURE__ */ $constructor("ZodNumberFormat", (inst, def) => {
	$ZodNumberFormat.init(inst, def);
	ZodNumber.init(inst, def);
});
function int(params) {
	return _int(ZodNumberFormat, params);
}
const ZodBoolean = /* @__PURE__ */ $constructor("ZodBoolean", (inst, def) => {
	$ZodBoolean.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => booleanProcessor(inst, ctx, json, params);
});
function boolean(params) {
	return _boolean(ZodBoolean, params);
}
const ZodUnknown = /* @__PURE__ */ $constructor("ZodUnknown", (inst, def) => {
	$ZodUnknown.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => unknownProcessor(inst, ctx, json, params);
});
function unknown() {
	return _unknown(ZodUnknown);
}
const ZodNever = /* @__PURE__ */ $constructor("ZodNever", (inst, def) => {
	$ZodNever.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => neverProcessor(inst, ctx, json, params);
});
function never(params) {
	return _never(ZodNever, params);
}
const ZodArray = /* @__PURE__ */ $constructor("ZodArray", (inst, def) => {
	$ZodArray.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => arrayProcessor(inst, ctx, json, params);
	inst.element = def.element;
	_installLazyMethods(inst, "ZodArray", {
		min(n, params) {
			return this.check(_minLength(n, params));
		},
		nonempty(params) {
			return this.check(_minLength(1, params));
		},
		max(n, params) {
			return this.check(_maxLength(n, params));
		},
		length(n, params) {
			return this.check(_length(n, params));
		},
		unwrap() {
			return this.element;
		}
	});
});
function array(element, params) {
	return _array(ZodArray, element, params);
}
const ZodObject = /* @__PURE__ */ $constructor("ZodObject", (inst, def) => {
	$ZodObjectJIT.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => objectProcessor(inst, ctx, json, params);
	defineLazy(inst, "shape", () => {
		return def.shape;
	});
	_installLazyMethods(inst, "ZodObject", {
		keyof() {
			return _enum(Object.keys(this._zod.def.shape));
		},
		catchall(catchall) {
			return this.clone({
				...this._zod.def,
				catchall
			});
		},
		passthrough() {
			return this.clone({
				...this._zod.def,
				catchall: unknown()
			});
		},
		loose() {
			return this.clone({
				...this._zod.def,
				catchall: unknown()
			});
		},
		strict() {
			return this.clone({
				...this._zod.def,
				catchall: never()
			});
		},
		strip() {
			return this.clone({
				...this._zod.def,
				catchall: void 0
			});
		},
		extend(incoming) {
			return extend(this, incoming);
		},
		safeExtend(incoming) {
			return safeExtend(this, incoming);
		},
		merge(other) {
			return merge(this, other);
		},
		pick(mask) {
			return pick(this, mask);
		},
		omit(mask) {
			return omit(this, mask);
		},
		partial(...args) {
			return partial(ZodOptional, this, args[0]);
		},
		required(...args) {
			return required(ZodNonOptional, this, args[0]);
		}
	});
});
function object(shape, params) {
	return new ZodObject({
		type: "object",
		shape: shape ?? {},
		...normalizeParams(params)
	});
}
const ZodUnion = /* @__PURE__ */ $constructor("ZodUnion", (inst, def) => {
	$ZodUnion.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => unionProcessor(inst, ctx, json, params);
	inst.options = def.options;
});
function union(options, params) {
	return new ZodUnion({
		type: "union",
		options,
		...normalizeParams(params)
	});
}
const ZodDiscriminatedUnion = /* @__PURE__ */ $constructor("ZodDiscriminatedUnion", (inst, def) => {
	ZodUnion.init(inst, def);
	$ZodDiscriminatedUnion.init(inst, def);
});
function discriminatedUnion(discriminator, options, params) {
	return new ZodDiscriminatedUnion({
		type: "union",
		options,
		discriminator,
		...normalizeParams(params)
	});
}
const ZodIntersection = /* @__PURE__ */ $constructor("ZodIntersection", (inst, def) => {
	$ZodIntersection.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => intersectionProcessor(inst, ctx, json, params);
});
function intersection(left, right) {
	return new ZodIntersection({
		type: "intersection",
		left,
		right
	});
}
const ZodRecord = /* @__PURE__ */ $constructor("ZodRecord", (inst, def) => {
	$ZodRecord.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => recordProcessor(inst, ctx, json, params);
	inst.keyType = def.keyType;
	inst.valueType = def.valueType;
});
function record(keyType, valueType, params) {
	if (!valueType || !valueType._zod) return new ZodRecord({
		type: "record",
		keyType: string(),
		valueType: keyType,
		...normalizeParams(valueType)
	});
	return new ZodRecord({
		type: "record",
		keyType,
		valueType,
		...normalizeParams(params)
	});
}
const ZodEnum = /* @__PURE__ */ $constructor("ZodEnum", (inst, def) => {
	$ZodEnum.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => enumProcessor(inst, ctx, json, params);
	inst.enum = def.entries;
	inst.options = Object.values(def.entries);
	const keys = new Set(Object.keys(def.entries));
	inst.extract = (values, params) => {
		const newEntries = {};
		for (const value of values) if (keys.has(value)) newEntries[value] = def.entries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
	inst.exclude = (values, params) => {
		const newEntries = { ...def.entries };
		for (const value of values) if (keys.has(value)) delete newEntries[value];
		else throw new Error(`Key ${value} not found in enum`);
		return new ZodEnum({
			...def,
			checks: [],
			...normalizeParams(params),
			entries: newEntries
		});
	};
});
function _enum(values, params) {
	return new ZodEnum({
		type: "enum",
		entries: Array.isArray(values) ? Object.fromEntries(values.map((v) => [v, v])) : values,
		...normalizeParams(params)
	});
}
const ZodLiteral = /* @__PURE__ */ $constructor("ZodLiteral", (inst, def) => {
	$ZodLiteral.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => literalProcessor(inst, ctx, json, params);
	inst.values = new Set(def.values);
	Object.defineProperty(inst, "value", { get() {
		if (def.values.length > 1) throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");
		return def.values[0];
	} });
});
function literal(value, params) {
	return new ZodLiteral({
		type: "literal",
		values: Array.isArray(value) ? value : [value],
		...normalizeParams(params)
	});
}
const ZodTransform = /* @__PURE__ */ $constructor("ZodTransform", (inst, def) => {
	$ZodTransform.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => transformProcessor(inst, ctx, json, params);
	inst._zod.parse = (payload, _ctx) => {
		if (_ctx.direction === "backward") throw new $ZodEncodeError(inst.constructor.name);
		payload.addIssue = (issue$1) => {
			if (typeof issue$1 === "string") payload.issues.push(issue(issue$1, payload.value, def));
			else {
				const _issue = issue$1;
				if (_issue.fatal) _issue.continue = false;
				_issue.code ?? (_issue.code = "custom");
				_issue.input ?? (_issue.input = payload.value);
				_issue.inst ?? (_issue.inst = inst);
				payload.issues.push(issue(_issue));
			}
		};
		const output = def.transform(payload.value, payload);
		if (output instanceof Promise) return output.then((output) => {
			payload.value = output;
			return payload;
		});
		payload.value = output;
		return payload;
	};
});
function transform(fn) {
	return new ZodTransform({
		type: "transform",
		transform: fn
	});
}
const ZodOptional = /* @__PURE__ */ $constructor("ZodOptional", (inst, def) => {
	$ZodOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function optional(innerType) {
	return new ZodOptional({
		type: "optional",
		innerType
	});
}
const ZodExactOptional = /* @__PURE__ */ $constructor("ZodExactOptional", (inst, def) => {
	$ZodExactOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => optionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function exactOptional(innerType) {
	return new ZodExactOptional({
		type: "optional",
		innerType
	});
}
const ZodNullable = /* @__PURE__ */ $constructor("ZodNullable", (inst, def) => {
	$ZodNullable.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nullableProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nullable(innerType) {
	return new ZodNullable({
		type: "nullable",
		innerType
	});
}
const ZodDefault = /* @__PURE__ */ $constructor("ZodDefault", (inst, def) => {
	$ZodDefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => defaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeDefault = inst.unwrap;
});
function _default(innerType, defaultValue) {
	return new ZodDefault({
		type: "default",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
const ZodPrefault = /* @__PURE__ */ $constructor("ZodPrefault", (inst, def) => {
	$ZodPrefault.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => prefaultProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function prefault(innerType, defaultValue) {
	return new ZodPrefault({
		type: "prefault",
		innerType,
		get defaultValue() {
			return typeof defaultValue === "function" ? defaultValue() : shallowClone(defaultValue);
		}
	});
}
const ZodNonOptional = /* @__PURE__ */ $constructor("ZodNonOptional", (inst, def) => {
	$ZodNonOptional.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => nonoptionalProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function nonoptional(innerType, params) {
	return new ZodNonOptional({
		type: "nonoptional",
		innerType,
		...normalizeParams(params)
	});
}
const ZodCatch = /* @__PURE__ */ $constructor("ZodCatch", (inst, def) => {
	$ZodCatch.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => catchProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
	inst.removeCatch = inst.unwrap;
});
function _catch(innerType, catchValue) {
	return new ZodCatch({
		type: "catch",
		innerType,
		catchValue: typeof catchValue === "function" ? catchValue : () => catchValue
	});
}
const ZodPipe = /* @__PURE__ */ $constructor("ZodPipe", (inst, def) => {
	$ZodPipe.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => pipeProcessor(inst, ctx, json, params);
	inst.in = def.in;
	inst.out = def.out;
});
function pipe(in_, out) {
	return new ZodPipe({
		type: "pipe",
		in: in_,
		out
	});
}
const ZodReadonly = /* @__PURE__ */ $constructor("ZodReadonly", (inst, def) => {
	$ZodReadonly.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => readonlyProcessor(inst, ctx, json, params);
	inst.unwrap = () => inst._zod.def.innerType;
});
function readonly(innerType) {
	return new ZodReadonly({
		type: "readonly",
		innerType
	});
}
const ZodCustom = /* @__PURE__ */ $constructor("ZodCustom", (inst, def) => {
	$ZodCustom.init(inst, def);
	ZodType.init(inst, def);
	inst._zod.processJSONSchema = (ctx, json, params) => customProcessor(inst, ctx, json, params);
});
function refine(fn, _params = {}) {
	return _refine(ZodCustom, fn, _params);
}
function superRefine(fn, params) {
	return _superRefine(fn, params);
}
const describe = describe$1;
const meta = meta$1;

//#endregion
//#region ../../packages/plugin-types/dist/index.js
/**
* Zod schema for PluginManifest validation
*
* Used to validate manifest.json from plugin bundles at every parse site:
* - Client-side download (marketplace.ts extractBundle)
* - R2 load (api/handlers/marketplace.ts loadBundleFromR2)
* - CLI publish preview (cli/commands/publish.ts readManifestFromTarball)
* - Marketplace ingest extends this with publishing-specific fields
*/
/**
* Current capability names — the ones authors should use going forward.
* See `PluginCapability` in `types.ts` for documentation of each.
*/
const CURRENT_PLUGIN_CAPABILITIES = [
	"network:request",
	"network:request:unrestricted",
	"content:read",
	"content:write",
	"taxonomies:read",
	"media:read",
	"media:write",
	"users:read",
	"email:send",
	"hooks.email-transport:register",
	"hooks.email-events:register",
	"hooks.page-fragments:register"
];
/**
* Legacy capability names accepted during the deprecation window.
* Normalized to current names via `normalizeCapability()` in types.ts
* before reaching the runtime. Plugin authors are warned at bundle/validate
* and hard-failed at publish.
*/
const DEPRECATED_PLUGIN_CAPABILITIES = [
	"network:fetch",
	"network:fetch:any",
	"read:content",
	"write:content",
	"read:media",
	"write:media",
	"read:users",
	"email:provide",
	"email:intercept",
	"page:inject"
];
/**
* Full set of accepted capability strings — current + deprecated.
*
* The manifest schema accepts both during the transition. The runtime only
* ever sees current names because `normalizeCapability()` rewrites legacy
* names at every external boundary (definePlugin, adaptSandboxEntry).
*/
const PLUGIN_CAPABILITIES = [...CURRENT_PLUGIN_CAPABILITIES, ...DEPRECATED_PLUGIN_CAPABILITIES];
/** Must stay in sync with FieldType in schema/types.ts */
const FIELD_TYPES = [
	"string",
	"text",
	"number",
	"integer",
	"boolean",
	"datetime",
	"select",
	"multiSelect",
	"portableText",
	"image",
	"file",
	"reference",
	"json",
	"slug",
	"repeater"
];
const HOOK_NAMES = [
	"plugin:install",
	"plugin:activate",
	"plugin:deactivate",
	"plugin:uninstall",
	"content:beforeSave",
	"content:afterSave",
	"content:beforeDelete",
	"content:afterDelete",
	"content:afterPublish",
	"content:afterUnpublish",
	"content:afterRestore",
	"content:afterSchedule",
	"content:afterUnschedule",
	"media:beforeUpload",
	"media:afterUpload",
	"cron",
	"email:beforeSend",
	"email:deliver",
	"email:afterSend",
	"comment:beforeCreate",
	"comment:moderate",
	"comment:afterCreate",
	"comment:afterModerate",
	"page:metadata",
	"page:fragments"
];
/**
* Structured hook entry for manifest — name plus optional metadata.
* During a transition period, both plain strings and objects are accepted.
*/
const manifestHookEntrySchema = object({
	name: _enum(HOOK_NAMES),
	exclusive: boolean().optional(),
	priority: number().int().optional(),
	timeout: number().int().positive().optional()
});
/**
* Structured route entry for manifest — name plus optional metadata.
* Both plain strings and objects are accepted; strings are normalized
* to `{ name }` objects via `normalizeManifestRoute()`.
*/
/** Route names must be safe path segments — alphanumeric, hyphens, underscores, forward slashes */
const routeNamePattern = /^[a-zA-Z0-9][a-zA-Z0-9_\-/]*$/;
const manifestRouteEntrySchema = object({
	name: string().min(1).regex(routeNamePattern, "Route name must be a safe path segment"),
	public: boolean().optional()
});
/** Index field names must be valid identifiers to prevent SQL injection via JSON path expressions */
const indexFieldName = string().regex(/^[a-zA-Z][a-zA-Z0-9_]*$/);
const storageCollectionSchema = object({
	indexes: array(union([indexFieldName, array(indexFieldName)])),
	uniqueIndexes: array(union([indexFieldName, array(indexFieldName)])).optional()
});
const baseSettingFields = {
	label: string(),
	description: string().optional()
};
const settingFieldSchema = discriminatedUnion("type", [
	object({
		...baseSettingFields,
		type: literal("string"),
		default: string().optional(),
		multiline: boolean().optional()
	}),
	object({
		...baseSettingFields,
		type: literal("number"),
		default: number().optional(),
		min: number().optional(),
		max: number().optional()
	}),
	object({
		...baseSettingFields,
		type: literal("boolean"),
		default: boolean().optional()
	}),
	object({
		...baseSettingFields,
		type: literal("select"),
		options: array(object({
			value: string(),
			label: string()
		})),
		default: string().optional()
	}),
	object({
		...baseSettingFields,
		type: literal("secret")
	}),
	object({
		...baseSettingFields,
		type: literal("url"),
		default: string().optional(),
		placeholder: string().optional()
	}),
	object({
		...baseSettingFields,
		type: literal("email"),
		default: string().optional(),
		placeholder: string().optional()
	})
]);
const adminPageSchema = object({
	path: string(),
	label: string(),
	icon: string().optional()
});
const dashboardWidgetSchema = object({
	id: string(),
	size: _enum([
		"full",
		"half",
		"third"
	]).optional(),
	title: string().optional()
});
const pluginAdminConfigSchema = object({
	entry: string().optional(),
	settingsSchema: record(string(), settingFieldSchema).optional(),
	pages: array(adminPageSchema).optional(),
	widgets: array(dashboardWidgetSchema).optional(),
	fieldWidgets: array(object({
		name: string().min(1),
		label: string().min(1),
		fieldTypes: array(_enum(FIELD_TYPES)),
		elements: array(object({
			type: string(),
			action_id: string(),
			label: string().optional()
		}).passthrough()).optional()
	})).optional()
});
/**
* An operation's constraint object. Open vocabulary: keys the runtime
* recognises are enforced, others are advisory. The bundler emits `{}` for a
* granted operation; presence (not value) signals the grant.
*/
const accessConstraints = record(string(), unknown());
/**
* Structured trust contract embedded in the bundle manifest. Mirrors
* `DeclaredAccess` in `@emdash-cms/plugin-types`. Categories are host
* subsystems; operations are modes of participation.
*/
const declaredAccessSchema = object({
	content: object({
		read: accessConstraints.optional(),
		write: accessConstraints.optional()
	}).optional(),
	taxonomies: object({ read: accessConstraints.optional() }).optional(),
	media: object({
		read: accessConstraints.optional(),
		write: accessConstraints.optional()
	}).optional(),
	network: object({ request: object({ allowedHosts: array(string()).min(1).optional() }).optional() }).optional(),
	email: object({
		send: accessConstraints.optional(),
		events: accessConstraints.optional(),
		transport: accessConstraints.optional()
	}).optional(),
	page: object({ fragments: accessConstraints.optional() }).optional(),
	users: object({ read: accessConstraints.optional() }).optional()
});
/**
* Zod schema matching the PluginManifest interface from types.ts.
*
* Every JSON.parse of a manifest.json should validate through this.
*
* `declaredAccess` is the trust contract; `capabilities`/`allowedHosts` are the
* runtime's enforcement currency. Apply `reconcileManifestAccess` after parsing
* to make them consistent (declaredAccess authoritative when present). Kept a
* plain object (no `.transform`) because callers `.pick()`/`.extend()` it.
*/
const pluginManifestSchema = object({
	id: string().min(1),
	version: string().min(1),
	declaredAccess: declaredAccessSchema.optional(),
	capabilities: array(_enum(PLUGIN_CAPABILITIES)),
	allowedHosts: array(string()),
	storage: record(string(), storageCollectionSchema),
	hooks: array(union([_enum(HOOK_NAMES), manifestHookEntrySchema])),
	routes: array(union([string().min(1).regex(routeNamePattern, "Route name must be a safe path segment"), manifestRouteEntrySchema])),
	admin: pluginAdminConfigSchema
});
/**
* Reconcile a parsed manifest's trust contract with its enforcement currency.
* `declaredAccess` is authoritative: when present, `capabilities`/`allowedHosts`
* are re-derived from it so what the runtime enforces always matches what was
* recorded and consented to. A pre-migration bundle without `declaredAccess`
* has it derived from the legacy capability list instead. The result always
* carries both, mutually consistent. Apply this at every bundle-parse site.
*/
function reconcileManifestAccess(manifest) {
	return manifest.declaredAccess ? {
		...manifest,
		...declaredAccessToCapabilities(manifest.declaredAccess)
	} : {
		...manifest,
		declaredAccess: capabilitiesToDeclaredAccess(manifest.capabilities, manifest.allowedHosts)
	};
}
/**
* Mapping from deprecated capability names to their current replacements.
*
* Used to compare manifests across the rename without flagging spurious
* "capability changed" prompts on upgrade, and to produce the warning
* messages at bundle time.
*/
const CAPABILITY_RENAMES = Object.freeze({
	"network:fetch": "network:request",
	"network:fetch:any": "network:request:unrestricted",
	"read:content": "content:read",
	"write:content": "content:write",
	"read:media": "media:read",
	"write:media": "media:write",
	"read:users": "users:read",
	"email:provide": "hooks.email-transport:register",
	"email:intercept": "hooks.email-events:register",
	"page:inject": "hooks.page-fragments:register"
});
/**
* Type guard: is this capability one of the deprecated legacy names?
*
* Uses an own-property check so prototype keys like "toString" don't
* accidentally pass.
*/
function isDeprecatedCapability(cap) {
	return Object.hasOwn(CAPABILITY_RENAMES, cap);
}
/**
* Normalize a capability string -- deprecated names map to current names,
* current names pass through unchanged. Unknown strings are returned as-is
* so downstream validators can produce a precise error.
*/
function normalizeCapability(cap) {
	if (isDeprecatedCapability(cap)) return CAPABILITY_RENAMES[cap];
	return cap;
}
/**
* Lower a normalized capability list + `allowedHosts` into the structured
* `declaredAccess` contract. Total over the current capability vocabulary and
* the inverse of {@link declaredAccessToCapabilities} for implication-closed
* inputs (the shape `definePlugin` produces).
*
* Network semantics are faithful to the legacy capability/allowedHosts model:
* an ABSENT `allowedHosts` key means unrestricted (`network:request:unrestricted`);
* a PRESENT `allowedHosts` -- even an empty array -- means host-restricted
* (`network:request`), where the empty list is deny-all at the runtime boundary.
* An empty list never widens to unrestricted. (The record lexicon forbids the
* empty array and publish rejects `network:request` with no hosts, so deny-all
* only arises for non-registry/in-process plugins.)
*/
function capabilitiesToDeclaredAccess(capabilities, allowedHosts) {
	const caps = new Set(capabilities.map((c) => normalizeCapability(c)));
	const out = {};
	if (caps.has("content:read") || caps.has("content:write")) {
		out.content = { read: {} };
		if (caps.has("content:write")) out.content.write = {};
	}
	if (caps.has("taxonomies:read")) out.taxonomies = { read: {} };
	if (caps.has("media:read") || caps.has("media:write")) {
		out.media = { read: {} };
		if (caps.has("media:write")) out.media.write = {};
	}
	if (caps.has("network:request:unrestricted")) out.network = { request: {} };
	else if (caps.has("network:request")) out.network = { request: { allowedHosts: [...allowedHosts] } };
	if (caps.has("email:send")) (out.email ??= {}).send = {};
	if (caps.has("hooks.email-events:register")) (out.email ??= {}).events = {};
	if (caps.has("hooks.email-transport:register")) (out.email ??= {}).transport = {};
	if (caps.has("hooks.page-fragments:register")) out.page = { fragments: {} };
	if (caps.has("users:read")) out.users = { read: {} };
	return out;
}
/**
* Raise a `declaredAccess` block back to normalized capability strings +
* `allowedHosts` -- the runtime's internal enforcement currency. Total: every
* facet maps to exactly one capability. The result is closed under the same
* implications `definePlugin` applies (write implies read; unrestricted implies
* request), so it round-trips with {@link capabilitiesToDeclaredAccess}.
*/
function declaredAccessToCapabilities(declaredAccess) {
	const caps = /* @__PURE__ */ new Set();
	let allowedHosts = [];
	if (declaredAccess.content?.read) caps.add("content:read");
	if (declaredAccess.content?.write) {
		caps.add("content:write");
		caps.add("content:read");
	}
	if (declaredAccess.taxonomies?.read) caps.add("taxonomies:read");
	if (declaredAccess.media?.read) caps.add("media:read");
	if (declaredAccess.media?.write) {
		caps.add("media:write");
		caps.add("media:read");
	}
	if (declaredAccess.network?.request) {
		const hosts = declaredAccess.network.request.allowedHosts;
		if (hosts === void 0) {
			caps.add("network:request:unrestricted");
			caps.add("network:request");
		} else {
			caps.add("network:request");
			allowedHosts = [...hosts];
		}
	}
	if (declaredAccess.email?.send) caps.add("email:send");
	if (declaredAccess.email?.events) caps.add("hooks.email-events:register");
	if (declaredAccess.email?.transport) caps.add("hooks.email-transport:register");
	if (declaredAccess.page?.fragments) caps.add("hooks.page-fragments:register");
	if (declaredAccess.users?.read) caps.add("users:read");
	return {
		capabilities: [...caps],
		allowedHosts
	};
}

//#endregion
//#region ../../node_modules/.pnpm/modern-tar@0.7.6/node_modules/modern-tar/dist/web/index.js
function createGzipDecoder() {
	return new DecompressionStream("gzip");
}

//#endregion
//#region ../../packages/registry-verification/dist/index.js
var __commonJSMin = (cb, mod) => () => (mod || cb((mod = { exports: {} }).exports, mod), mod.exports);
var __require = /* @__PURE__ */ createRequire("file:///emdash-registry-verification.js");
const DEFAULT_FETCH_LIMITS = {
	headerTimeoutMs: 1e4,
	totalTimeoutMs: 3e4,
	maxBytes: 25 * 1024 * 1024,
	maxRedirects: 3
};
const DID_DOCUMENT_MAX_BYTES = 256 * 1024;
/** Maximum accepted gzip payload size. */
const MAX_BUNDLE_COMPRESSED_BYTES$1 = 384 * 1024;
/** Maximum aggregate size of regular-file contents. */
const MAX_BUNDLE_SIZE$1 = 256 * 1024;
/** Maximum size of one regular file. */
const MAX_BUNDLE_FILE_BYTES$1 = 128 * 1024;
/** Maximum number of regular files. */
const MAX_BUNDLE_FILE_COUNT$1 = 20;
/** Maximum total tar entries, including harmless directory entries. */
const MAX_BUNDLE_TAR_ENTRY_COUNT$1 = 32;
/**
* Maximum tar stream size after decompression. This includes USTAR headers,
* file padding, and the end marker in addition to the regular-file contents.
*/
const MAX_BUNDLE_DECOMPRESSED_BYTES$1 = MAX_BUNDLE_SIZE$1 + MAX_BUNDLE_TAR_ENTRY_COUNT$1 * 512 + MAX_BUNDLE_FILE_COUNT$1 * 511 + 2 * 512;
const TAR_BLOCK_BYTES$1 = 512;
const TAR_END_BYTES$1 = TAR_BLOCK_BYTES$1 * 2;
const decoder$1 = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: false
});
var require_envelope = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Signature = exports.Envelope = void 0;
	exports.Envelope = {
		fromJSON(object) {
			return {
				payload: isSet(object.payload) ? Buffer.from(bytesFromBase64(object.payload)) : Buffer.alloc(0),
				payloadType: isSet(object.payloadType) ? globalThis.String(object.payloadType) : "",
				signatures: globalThis.Array.isArray(object?.signatures) ? object.signatures.map((e) => exports.Signature.fromJSON(e)) : []
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.payload.length !== 0) obj.payload = base64FromBytes(message.payload);
			if (message.payloadType !== "") obj.payloadType = message.payloadType;
			if (message.signatures?.length) obj.signatures = message.signatures.map((e) => exports.Signature.toJSON(e));
			return obj;
		}
	};
	exports.Signature = {
		fromJSON(object) {
			return {
				sig: isSet(object.sig) ? Buffer.from(bytesFromBase64(object.sig)) : Buffer.alloc(0),
				keyid: isSet(object.keyid) ? globalThis.String(object.keyid) : ""
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.sig.length !== 0) obj.sig = base64FromBytes(message.sig);
			if (message.keyid !== "") obj.keyid = message.keyid;
			return obj;
		}
	};
	function bytesFromBase64(b64) {
		return Uint8Array.from(globalThis.Buffer.from(b64, "base64"));
	}
	function base64FromBytes(arr) {
		return globalThis.Buffer.from(arr).toString("base64");
	}
	function isSet(value) {
		return value !== null && value !== void 0;
	}
}));
var require_timestamp$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Timestamp = void 0;
	exports.Timestamp = {
		fromJSON(object) {
			return {
				seconds: isSet(object.seconds) ? globalThis.String(object.seconds) : "0",
				nanos: isSet(object.nanos) ? globalThis.Number(object.nanos) : 0
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.seconds !== "0") obj.seconds = message.seconds;
			if (message.nanos !== 0) obj.nanos = Math.round(message.nanos);
			return obj;
		}
	};
	function isSet(value) {
		return value !== null && value !== void 0;
	}
}));
var require_sigstore_common = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.TimeRange = exports.X509CertificateChain = exports.SubjectAlternativeName = exports.X509Certificate = exports.DistinguishedName = exports.ObjectIdentifierValuePair = exports.ObjectIdentifier = exports.PublicKeyIdentifier = exports.PublicKey = exports.RFC3161SignedTimestamp = exports.LogId = exports.MessageSignature = exports.HashOutput = exports.SubjectAlternativeNameType = exports.PublicKeyDetails = exports.HashAlgorithm = void 0;
	exports.hashAlgorithmFromJSON = hashAlgorithmFromJSON;
	exports.hashAlgorithmToJSON = hashAlgorithmToJSON;
	exports.publicKeyDetailsFromJSON = publicKeyDetailsFromJSON;
	exports.publicKeyDetailsToJSON = publicKeyDetailsToJSON;
	exports.subjectAlternativeNameTypeFromJSON = subjectAlternativeNameTypeFromJSON;
	exports.subjectAlternativeNameTypeToJSON = subjectAlternativeNameTypeToJSON;
	const timestamp_1 = require_timestamp$2();
	/**
	* Only a subset of the secure hash standard algorithms are supported.
	* See <https://nvlpubs.nist.gov/nistpubs/FIPS/NIST.FIPS.180-4.pdf> for more
	* details.
	* UNSPECIFIED SHOULD not be used, primary reason for inclusion is to force
	* any proto JSON serialization to emit the used hash algorithm, as default
	* option is to *omit* the default value of an enum (which is the first
	* value, represented by '0'.
	*/
	var HashAlgorithm;
	(function(HashAlgorithm) {
		HashAlgorithm[HashAlgorithm["HASH_ALGORITHM_UNSPECIFIED"] = 0] = "HASH_ALGORITHM_UNSPECIFIED";
		HashAlgorithm[HashAlgorithm["SHA2_256"] = 1] = "SHA2_256";
		HashAlgorithm[HashAlgorithm["SHA2_384"] = 2] = "SHA2_384";
		HashAlgorithm[HashAlgorithm["SHA2_512"] = 3] = "SHA2_512";
		/**
		* SHA3_256 - Used for LMS
		*
		* @deprecated
		*/
		HashAlgorithm[HashAlgorithm["SHA3_256"] = 4] = "SHA3_256";
		/**
		* SHA3_384 - Used for LMS
		*
		* @deprecated
		*/
		HashAlgorithm[HashAlgorithm["SHA3_384"] = 5] = "SHA3_384";
	})(HashAlgorithm || (exports.HashAlgorithm = HashAlgorithm = {}));
	function hashAlgorithmFromJSON(object) {
		switch (object) {
			case 0:
			case "HASH_ALGORITHM_UNSPECIFIED": return HashAlgorithm.HASH_ALGORITHM_UNSPECIFIED;
			case 1:
			case "SHA2_256": return HashAlgorithm.SHA2_256;
			case 2:
			case "SHA2_384": return HashAlgorithm.SHA2_384;
			case 3:
			case "SHA2_512": return HashAlgorithm.SHA2_512;
			case 4:
			case "SHA3_256": return HashAlgorithm.SHA3_256;
			case 5:
			case "SHA3_384": return HashAlgorithm.SHA3_384;
			default: throw new globalThis.Error("Unrecognized enum value " + object + " for enum HashAlgorithm");
		}
	}
	function hashAlgorithmToJSON(object) {
		switch (object) {
			case HashAlgorithm.HASH_ALGORITHM_UNSPECIFIED: return "HASH_ALGORITHM_UNSPECIFIED";
			case HashAlgorithm.SHA2_256: return "SHA2_256";
			case HashAlgorithm.SHA2_384: return "SHA2_384";
			case HashAlgorithm.SHA2_512: return "SHA2_512";
			case HashAlgorithm.SHA3_256: return "SHA3_256";
			case HashAlgorithm.SHA3_384: return "SHA3_384";
			default: throw new globalThis.Error("Unrecognized enum value " + object + " for enum HashAlgorithm");
		}
	}
	/**
	* Details of a specific public key, capturing the the key encoding method,
	* and signature algorithm.
	*
	* PublicKeyDetails captures the public key/hash algorithm combinations
	* recommended in the Sigstore ecosystem.
	*
	* This is modelled as a linear set as we want to provide a small number of
	* opinionated options instead of allowing every possible permutation.
	*
	* Any changes to this enum MUST be reflected in the algorithm registry.
	*
	* See: <https://github.com/sigstore/architecture-docs/blob/main/algorithm-registry.md>
	*
	* To avoid the possibility of contradicting formats such as PKCS1 with
	* ED25519 the valid permutations are listed as a linear set instead of a
	* cartesian set (i.e one combined variable instead of two, one for encoding
	* and one for the signature algorithm).
	*/
	var PublicKeyDetails;
	(function(PublicKeyDetails) {
		PublicKeyDetails[PublicKeyDetails["PUBLIC_KEY_DETAILS_UNSPECIFIED"] = 0] = "PUBLIC_KEY_DETAILS_UNSPECIFIED";
		/**
		* PKCS1_RSA_PKCS1V5 - RSA
		*
		* @deprecated
		*/
		PublicKeyDetails[PublicKeyDetails["PKCS1_RSA_PKCS1V5"] = 1] = "PKCS1_RSA_PKCS1V5";
		/**
		* PKCS1_RSA_PSS - See RFC8017
		*
		* @deprecated
		*/
		PublicKeyDetails[PublicKeyDetails["PKCS1_RSA_PSS"] = 2] = "PKCS1_RSA_PSS";
		/** @deprecated */
		PublicKeyDetails[PublicKeyDetails["PKIX_RSA_PKCS1V5"] = 3] = "PKIX_RSA_PKCS1V5";
		/** @deprecated */
		PublicKeyDetails[PublicKeyDetails["PKIX_RSA_PSS"] = 4] = "PKIX_RSA_PSS";
		/** PKIX_RSA_PKCS1V15_2048_SHA256 - RSA public key in PKIX format, PKCS#1v1.5 signature */
		PublicKeyDetails[PublicKeyDetails["PKIX_RSA_PKCS1V15_2048_SHA256"] = 9] = "PKIX_RSA_PKCS1V15_2048_SHA256";
		PublicKeyDetails[PublicKeyDetails["PKIX_RSA_PKCS1V15_3072_SHA256"] = 10] = "PKIX_RSA_PKCS1V15_3072_SHA256";
		PublicKeyDetails[PublicKeyDetails["PKIX_RSA_PKCS1V15_4096_SHA256"] = 11] = "PKIX_RSA_PKCS1V15_4096_SHA256";
		/** PKIX_RSA_PSS_2048_SHA256 - RSA public key in PKIX format, RSASSA-PSS signature */
		PublicKeyDetails[PublicKeyDetails["PKIX_RSA_PSS_2048_SHA256"] = 16] = "PKIX_RSA_PSS_2048_SHA256";
		PublicKeyDetails[PublicKeyDetails["PKIX_RSA_PSS_3072_SHA256"] = 17] = "PKIX_RSA_PSS_3072_SHA256";
		PublicKeyDetails[PublicKeyDetails["PKIX_RSA_PSS_4096_SHA256"] = 18] = "PKIX_RSA_PSS_4096_SHA256";
		/**
		* PKIX_ECDSA_P256_HMAC_SHA_256 - ECDSA
		*
		* @deprecated
		*/
		PublicKeyDetails[PublicKeyDetails["PKIX_ECDSA_P256_HMAC_SHA_256"] = 6] = "PKIX_ECDSA_P256_HMAC_SHA_256";
		/** PKIX_ECDSA_P256_SHA_256 - See NIST FIPS 186-4 */
		PublicKeyDetails[PublicKeyDetails["PKIX_ECDSA_P256_SHA_256"] = 5] = "PKIX_ECDSA_P256_SHA_256";
		PublicKeyDetails[PublicKeyDetails["PKIX_ECDSA_P384_SHA_384"] = 12] = "PKIX_ECDSA_P384_SHA_384";
		PublicKeyDetails[PublicKeyDetails["PKIX_ECDSA_P521_SHA_512"] = 13] = "PKIX_ECDSA_P521_SHA_512";
		/** PKIX_ED25519 - Ed 25519 */
		PublicKeyDetails[PublicKeyDetails["PKIX_ED25519"] = 7] = "PKIX_ED25519";
		PublicKeyDetails[PublicKeyDetails["PKIX_ED25519_PH"] = 8] = "PKIX_ED25519_PH";
		/**
		* PKIX_ECDSA_P384_SHA_256 - These algorithms are deprecated and should not be used, but they
		* were/are being used by most Sigstore clients implementations.
		*
		* @deprecated
		*/
		PublicKeyDetails[PublicKeyDetails["PKIX_ECDSA_P384_SHA_256"] = 19] = "PKIX_ECDSA_P384_SHA_256";
		/** @deprecated */
		PublicKeyDetails[PublicKeyDetails["PKIX_ECDSA_P521_SHA_256"] = 20] = "PKIX_ECDSA_P521_SHA_256";
		/**
		* LMS_SHA256 - LMS and LM-OTS
		*
		* These algorithms are deprecated and should not be used.
		* There are no plans to support SLH-DSA at this time.
		*
		* USER WARNING: LMS and LM-OTS are both stateful signature schemes.
		* Using them correctly requires discretion and careful consideration
		* to ensure that individual secret keys are not used more than once.
		* In addition, LM-OTS is a single-use scheme, meaning that it
		* MUST NOT be used for more than one signature per LM-OTS key.
		* If you cannot maintain these invariants, you MUST NOT use these
		* schemes.
		*
		* @deprecated
		*/
		PublicKeyDetails[PublicKeyDetails["LMS_SHA256"] = 14] = "LMS_SHA256";
		/** @deprecated */
		PublicKeyDetails[PublicKeyDetails["LMOTS_SHA256"] = 15] = "LMOTS_SHA256";
		/**
		* ML_DSA_44 - ML-DSA
		*
		* These ML_DSA_44, ML_DSA_65 and ML-DSA_87 algorithms are the pure variants
		* that take data to sign rather than the prehash variants (HashML-DSA), which
		* take digests. While considered quantum-resistant, their usage
		* involves tradeoffs in that signatures and keys are much larger, and
		* this makes deployments more costly.
		*
		* USER WARNING: ML_DSA_44, ML_DSA_65 and ML_DSA_87 are experimental algorithms.
		* In the future they MAY be used by private Sigstore deployments, but
		* they are not yet fully functional. This warning will be removed when
		* these algorithms are widely supported by Sigstore clients and servers,
		* but care should still be taken for production environments.
		*
		* See NIST FIPS 204, RFC 9881 for algorithm identifiers
		*/
		PublicKeyDetails[PublicKeyDetails["ML_DSA_44"] = 23] = "ML_DSA_44";
		PublicKeyDetails[PublicKeyDetails["ML_DSA_65"] = 21] = "ML_DSA_65";
		PublicKeyDetails[PublicKeyDetails["ML_DSA_87"] = 22] = "ML_DSA_87";
	})(PublicKeyDetails || (exports.PublicKeyDetails = PublicKeyDetails = {}));
	function publicKeyDetailsFromJSON(object) {
		switch (object) {
			case 0:
			case "PUBLIC_KEY_DETAILS_UNSPECIFIED": return PublicKeyDetails.PUBLIC_KEY_DETAILS_UNSPECIFIED;
			case 1:
			case "PKCS1_RSA_PKCS1V5": return PublicKeyDetails.PKCS1_RSA_PKCS1V5;
			case 2:
			case "PKCS1_RSA_PSS": return PublicKeyDetails.PKCS1_RSA_PSS;
			case 3:
			case "PKIX_RSA_PKCS1V5": return PublicKeyDetails.PKIX_RSA_PKCS1V5;
			case 4:
			case "PKIX_RSA_PSS": return PublicKeyDetails.PKIX_RSA_PSS;
			case 9:
			case "PKIX_RSA_PKCS1V15_2048_SHA256": return PublicKeyDetails.PKIX_RSA_PKCS1V15_2048_SHA256;
			case 10:
			case "PKIX_RSA_PKCS1V15_3072_SHA256": return PublicKeyDetails.PKIX_RSA_PKCS1V15_3072_SHA256;
			case 11:
			case "PKIX_RSA_PKCS1V15_4096_SHA256": return PublicKeyDetails.PKIX_RSA_PKCS1V15_4096_SHA256;
			case 16:
			case "PKIX_RSA_PSS_2048_SHA256": return PublicKeyDetails.PKIX_RSA_PSS_2048_SHA256;
			case 17:
			case "PKIX_RSA_PSS_3072_SHA256": return PublicKeyDetails.PKIX_RSA_PSS_3072_SHA256;
			case 18:
			case "PKIX_RSA_PSS_4096_SHA256": return PublicKeyDetails.PKIX_RSA_PSS_4096_SHA256;
			case 6:
			case "PKIX_ECDSA_P256_HMAC_SHA_256": return PublicKeyDetails.PKIX_ECDSA_P256_HMAC_SHA_256;
			case 5:
			case "PKIX_ECDSA_P256_SHA_256": return PublicKeyDetails.PKIX_ECDSA_P256_SHA_256;
			case 12:
			case "PKIX_ECDSA_P384_SHA_384": return PublicKeyDetails.PKIX_ECDSA_P384_SHA_384;
			case 13:
			case "PKIX_ECDSA_P521_SHA_512": return PublicKeyDetails.PKIX_ECDSA_P521_SHA_512;
			case 7:
			case "PKIX_ED25519": return PublicKeyDetails.PKIX_ED25519;
			case 8:
			case "PKIX_ED25519_PH": return PublicKeyDetails.PKIX_ED25519_PH;
			case 19:
			case "PKIX_ECDSA_P384_SHA_256": return PublicKeyDetails.PKIX_ECDSA_P384_SHA_256;
			case 20:
			case "PKIX_ECDSA_P521_SHA_256": return PublicKeyDetails.PKIX_ECDSA_P521_SHA_256;
			case 14:
			case "LMS_SHA256": return PublicKeyDetails.LMS_SHA256;
			case 15:
			case "LMOTS_SHA256": return PublicKeyDetails.LMOTS_SHA256;
			case 23:
			case "ML_DSA_44": return PublicKeyDetails.ML_DSA_44;
			case 21:
			case "ML_DSA_65": return PublicKeyDetails.ML_DSA_65;
			case 22:
			case "ML_DSA_87": return PublicKeyDetails.ML_DSA_87;
			default: throw new globalThis.Error("Unrecognized enum value " + object + " for enum PublicKeyDetails");
		}
	}
	function publicKeyDetailsToJSON(object) {
		switch (object) {
			case PublicKeyDetails.PUBLIC_KEY_DETAILS_UNSPECIFIED: return "PUBLIC_KEY_DETAILS_UNSPECIFIED";
			case PublicKeyDetails.PKCS1_RSA_PKCS1V5: return "PKCS1_RSA_PKCS1V5";
			case PublicKeyDetails.PKCS1_RSA_PSS: return "PKCS1_RSA_PSS";
			case PublicKeyDetails.PKIX_RSA_PKCS1V5: return "PKIX_RSA_PKCS1V5";
			case PublicKeyDetails.PKIX_RSA_PSS: return "PKIX_RSA_PSS";
			case PublicKeyDetails.PKIX_RSA_PKCS1V15_2048_SHA256: return "PKIX_RSA_PKCS1V15_2048_SHA256";
			case PublicKeyDetails.PKIX_RSA_PKCS1V15_3072_SHA256: return "PKIX_RSA_PKCS1V15_3072_SHA256";
			case PublicKeyDetails.PKIX_RSA_PKCS1V15_4096_SHA256: return "PKIX_RSA_PKCS1V15_4096_SHA256";
			case PublicKeyDetails.PKIX_RSA_PSS_2048_SHA256: return "PKIX_RSA_PSS_2048_SHA256";
			case PublicKeyDetails.PKIX_RSA_PSS_3072_SHA256: return "PKIX_RSA_PSS_3072_SHA256";
			case PublicKeyDetails.PKIX_RSA_PSS_4096_SHA256: return "PKIX_RSA_PSS_4096_SHA256";
			case PublicKeyDetails.PKIX_ECDSA_P256_HMAC_SHA_256: return "PKIX_ECDSA_P256_HMAC_SHA_256";
			case PublicKeyDetails.PKIX_ECDSA_P256_SHA_256: return "PKIX_ECDSA_P256_SHA_256";
			case PublicKeyDetails.PKIX_ECDSA_P384_SHA_384: return "PKIX_ECDSA_P384_SHA_384";
			case PublicKeyDetails.PKIX_ECDSA_P521_SHA_512: return "PKIX_ECDSA_P521_SHA_512";
			case PublicKeyDetails.PKIX_ED25519: return "PKIX_ED25519";
			case PublicKeyDetails.PKIX_ED25519_PH: return "PKIX_ED25519_PH";
			case PublicKeyDetails.PKIX_ECDSA_P384_SHA_256: return "PKIX_ECDSA_P384_SHA_256";
			case PublicKeyDetails.PKIX_ECDSA_P521_SHA_256: return "PKIX_ECDSA_P521_SHA_256";
			case PublicKeyDetails.LMS_SHA256: return "LMS_SHA256";
			case PublicKeyDetails.LMOTS_SHA256: return "LMOTS_SHA256";
			case PublicKeyDetails.ML_DSA_44: return "ML_DSA_44";
			case PublicKeyDetails.ML_DSA_65: return "ML_DSA_65";
			case PublicKeyDetails.ML_DSA_87: return "ML_DSA_87";
			default: throw new globalThis.Error("Unrecognized enum value " + object + " for enum PublicKeyDetails");
		}
	}
	var SubjectAlternativeNameType;
	(function(SubjectAlternativeNameType) {
		SubjectAlternativeNameType[SubjectAlternativeNameType["SUBJECT_ALTERNATIVE_NAME_TYPE_UNSPECIFIED"] = 0] = "SUBJECT_ALTERNATIVE_NAME_TYPE_UNSPECIFIED";
		SubjectAlternativeNameType[SubjectAlternativeNameType["EMAIL"] = 1] = "EMAIL";
		SubjectAlternativeNameType[SubjectAlternativeNameType["URI"] = 2] = "URI";
		/**
		* OTHER_NAME - OID 1.3.6.1.4.1.57264.1.7
		* See https://github.com/sigstore/fulcio/blob/main/docs/oid-info.md#1361415726417--othername-san
		* for more details.
		*/
		SubjectAlternativeNameType[SubjectAlternativeNameType["OTHER_NAME"] = 3] = "OTHER_NAME";
	})(SubjectAlternativeNameType || (exports.SubjectAlternativeNameType = SubjectAlternativeNameType = {}));
	function subjectAlternativeNameTypeFromJSON(object) {
		switch (object) {
			case 0:
			case "SUBJECT_ALTERNATIVE_NAME_TYPE_UNSPECIFIED": return SubjectAlternativeNameType.SUBJECT_ALTERNATIVE_NAME_TYPE_UNSPECIFIED;
			case 1:
			case "EMAIL": return SubjectAlternativeNameType.EMAIL;
			case 2:
			case "URI": return SubjectAlternativeNameType.URI;
			case 3:
			case "OTHER_NAME": return SubjectAlternativeNameType.OTHER_NAME;
			default: throw new globalThis.Error("Unrecognized enum value " + object + " for enum SubjectAlternativeNameType");
		}
	}
	function subjectAlternativeNameTypeToJSON(object) {
		switch (object) {
			case SubjectAlternativeNameType.SUBJECT_ALTERNATIVE_NAME_TYPE_UNSPECIFIED: return "SUBJECT_ALTERNATIVE_NAME_TYPE_UNSPECIFIED";
			case SubjectAlternativeNameType.EMAIL: return "EMAIL";
			case SubjectAlternativeNameType.URI: return "URI";
			case SubjectAlternativeNameType.OTHER_NAME: return "OTHER_NAME";
			default: throw new globalThis.Error("Unrecognized enum value " + object + " for enum SubjectAlternativeNameType");
		}
	}
	exports.HashOutput = {
		fromJSON(object) {
			return {
				algorithm: isSet(object.algorithm) ? hashAlgorithmFromJSON(object.algorithm) : 0,
				digest: isSet(object.digest) ? Buffer.from(bytesFromBase64(object.digest)) : Buffer.alloc(0)
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.algorithm !== 0) obj.algorithm = hashAlgorithmToJSON(message.algorithm);
			if (message.digest.length !== 0) obj.digest = base64FromBytes(message.digest);
			return obj;
		}
	};
	exports.MessageSignature = {
		fromJSON(object) {
			return {
				messageDigest: isSet(object.messageDigest) ? exports.HashOutput.fromJSON(object.messageDigest) : void 0,
				signature: isSet(object.signature) ? Buffer.from(bytesFromBase64(object.signature)) : Buffer.alloc(0)
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.messageDigest !== void 0) obj.messageDigest = exports.HashOutput.toJSON(message.messageDigest);
			if (message.signature.length !== 0) obj.signature = base64FromBytes(message.signature);
			return obj;
		}
	};
	exports.LogId = {
		fromJSON(object) {
			return { keyId: isSet(object.keyId) ? Buffer.from(bytesFromBase64(object.keyId)) : Buffer.alloc(0) };
		},
		toJSON(message) {
			const obj = {};
			if (message.keyId.length !== 0) obj.keyId = base64FromBytes(message.keyId);
			return obj;
		}
	};
	exports.RFC3161SignedTimestamp = {
		fromJSON(object) {
			return { signedTimestamp: isSet(object.signedTimestamp) ? Buffer.from(bytesFromBase64(object.signedTimestamp)) : Buffer.alloc(0) };
		},
		toJSON(message) {
			const obj = {};
			if (message.signedTimestamp.length !== 0) obj.signedTimestamp = base64FromBytes(message.signedTimestamp);
			return obj;
		}
	};
	exports.PublicKey = {
		fromJSON(object) {
			return {
				rawBytes: isSet(object.rawBytes) ? Buffer.from(bytesFromBase64(object.rawBytes)) : void 0,
				keyDetails: isSet(object.keyDetails) ? publicKeyDetailsFromJSON(object.keyDetails) : 0,
				validFor: isSet(object.validFor) ? exports.TimeRange.fromJSON(object.validFor) : void 0
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.rawBytes !== void 0) obj.rawBytes = base64FromBytes(message.rawBytes);
			if (message.keyDetails !== 0) obj.keyDetails = publicKeyDetailsToJSON(message.keyDetails);
			if (message.validFor !== void 0) obj.validFor = exports.TimeRange.toJSON(message.validFor);
			return obj;
		}
	};
	exports.PublicKeyIdentifier = {
		fromJSON(object) {
			return { hint: isSet(object.hint) ? globalThis.String(object.hint) : "" };
		},
		toJSON(message) {
			const obj = {};
			if (message.hint !== "") obj.hint = message.hint;
			return obj;
		}
	};
	exports.ObjectIdentifier = {
		fromJSON(object) {
			return { id: globalThis.Array.isArray(object?.id) ? object.id.map((e) => globalThis.Number(e)) : [] };
		},
		toJSON(message) {
			const obj = {};
			if (message.id?.length) obj.id = message.id.map((e) => Math.round(e));
			return obj;
		}
	};
	exports.ObjectIdentifierValuePair = {
		fromJSON(object) {
			return {
				oid: isSet(object.oid) ? exports.ObjectIdentifier.fromJSON(object.oid) : void 0,
				value: isSet(object.value) ? Buffer.from(bytesFromBase64(object.value)) : Buffer.alloc(0)
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.oid !== void 0) obj.oid = exports.ObjectIdentifier.toJSON(message.oid);
			if (message.value.length !== 0) obj.value = base64FromBytes(message.value);
			return obj;
		}
	};
	exports.DistinguishedName = {
		fromJSON(object) {
			return {
				organization: isSet(object.organization) ? globalThis.String(object.organization) : "",
				commonName: isSet(object.commonName) ? globalThis.String(object.commonName) : ""
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.organization !== "") obj.organization = message.organization;
			if (message.commonName !== "") obj.commonName = message.commonName;
			return obj;
		}
	};
	exports.X509Certificate = {
		fromJSON(object) {
			return { rawBytes: isSet(object.rawBytes) ? Buffer.from(bytesFromBase64(object.rawBytes)) : Buffer.alloc(0) };
		},
		toJSON(message) {
			const obj = {};
			if (message.rawBytes.length !== 0) obj.rawBytes = base64FromBytes(message.rawBytes);
			return obj;
		}
	};
	exports.SubjectAlternativeName = {
		fromJSON(object) {
			return {
				type: isSet(object.type) ? subjectAlternativeNameTypeFromJSON(object.type) : 0,
				identity: isSet(object.regexp) ? {
					$case: "regexp",
					regexp: globalThis.String(object.regexp)
				} : isSet(object.value) ? {
					$case: "value",
					value: globalThis.String(object.value)
				} : void 0
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.type !== 0) obj.type = subjectAlternativeNameTypeToJSON(message.type);
			if (message.identity?.$case === "regexp") obj.regexp = message.identity.regexp;
			else if (message.identity?.$case === "value") obj.value = message.identity.value;
			return obj;
		}
	};
	exports.X509CertificateChain = {
		fromJSON(object) {
			return { certificates: globalThis.Array.isArray(object?.certificates) ? object.certificates.map((e) => exports.X509Certificate.fromJSON(e)) : [] };
		},
		toJSON(message) {
			const obj = {};
			if (message.certificates?.length) obj.certificates = message.certificates.map((e) => exports.X509Certificate.toJSON(e));
			return obj;
		}
	};
	exports.TimeRange = {
		fromJSON(object) {
			return {
				start: isSet(object.start) ? fromJsonTimestamp(object.start) : void 0,
				end: isSet(object.end) ? fromJsonTimestamp(object.end) : void 0
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.start !== void 0) obj.start = message.start.toISOString();
			if (message.end !== void 0) obj.end = message.end.toISOString();
			return obj;
		}
	};
	function bytesFromBase64(b64) {
		return Uint8Array.from(globalThis.Buffer.from(b64, "base64"));
	}
	function base64FromBytes(arr) {
		return globalThis.Buffer.from(arr).toString("base64");
	}
	function fromTimestamp(t) {
		let millis = (globalThis.Number(t.seconds) || 0) * 1e3;
		millis += (t.nanos || 0) / 1e6;
		return new globalThis.Date(millis);
	}
	function fromJsonTimestamp(o) {
		if (o instanceof globalThis.Date) return o;
		else if (typeof o === "string") return new globalThis.Date(o);
		else return fromTimestamp(timestamp_1.Timestamp.fromJSON(o));
	}
	function isSet(value) {
		return value !== null && value !== void 0;
	}
}));
var require_sigstore_rekor = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.TransparencyLogEntry = exports.InclusionPromise = exports.InclusionProof = exports.Checkpoint = exports.KindVersion = void 0;
	const sigstore_common_1 = require_sigstore_common();
	exports.KindVersion = {
		fromJSON(object) {
			return {
				kind: isSet(object.kind) ? globalThis.String(object.kind) : "",
				version: isSet(object.version) ? globalThis.String(object.version) : ""
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.kind !== "") obj.kind = message.kind;
			if (message.version !== "") obj.version = message.version;
			return obj;
		}
	};
	exports.Checkpoint = {
		fromJSON(object) {
			return { envelope: isSet(object.envelope) ? globalThis.String(object.envelope) : "" };
		},
		toJSON(message) {
			const obj = {};
			if (message.envelope !== "") obj.envelope = message.envelope;
			return obj;
		}
	};
	exports.InclusionProof = {
		fromJSON(object) {
			return {
				logIndex: isSet(object.logIndex) ? globalThis.String(object.logIndex) : "0",
				rootHash: isSet(object.rootHash) ? Buffer.from(bytesFromBase64(object.rootHash)) : Buffer.alloc(0),
				treeSize: isSet(object.treeSize) ? globalThis.String(object.treeSize) : "0",
				hashes: globalThis.Array.isArray(object?.hashes) ? object.hashes.map((e) => Buffer.from(bytesFromBase64(e))) : [],
				checkpoint: isSet(object.checkpoint) ? exports.Checkpoint.fromJSON(object.checkpoint) : void 0
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.logIndex !== "0") obj.logIndex = message.logIndex;
			if (message.rootHash.length !== 0) obj.rootHash = base64FromBytes(message.rootHash);
			if (message.treeSize !== "0") obj.treeSize = message.treeSize;
			if (message.hashes?.length) obj.hashes = message.hashes.map((e) => base64FromBytes(e));
			if (message.checkpoint !== void 0) obj.checkpoint = exports.Checkpoint.toJSON(message.checkpoint);
			return obj;
		}
	};
	exports.InclusionPromise = {
		fromJSON(object) {
			return { signedEntryTimestamp: isSet(object.signedEntryTimestamp) ? Buffer.from(bytesFromBase64(object.signedEntryTimestamp)) : Buffer.alloc(0) };
		},
		toJSON(message) {
			const obj = {};
			if (message.signedEntryTimestamp.length !== 0) obj.signedEntryTimestamp = base64FromBytes(message.signedEntryTimestamp);
			return obj;
		}
	};
	exports.TransparencyLogEntry = {
		fromJSON(object) {
			return {
				logIndex: isSet(object.logIndex) ? globalThis.String(object.logIndex) : "0",
				logId: isSet(object.logId) ? sigstore_common_1.LogId.fromJSON(object.logId) : void 0,
				kindVersion: isSet(object.kindVersion) ? exports.KindVersion.fromJSON(object.kindVersion) : void 0,
				integratedTime: isSet(object.integratedTime) ? globalThis.String(object.integratedTime) : "0",
				inclusionPromise: isSet(object.inclusionPromise) ? exports.InclusionPromise.fromJSON(object.inclusionPromise) : void 0,
				inclusionProof: isSet(object.inclusionProof) ? exports.InclusionProof.fromJSON(object.inclusionProof) : void 0,
				canonicalizedBody: isSet(object.canonicalizedBody) ? Buffer.from(bytesFromBase64(object.canonicalizedBody)) : Buffer.alloc(0)
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.logIndex !== "0") obj.logIndex = message.logIndex;
			if (message.logId !== void 0) obj.logId = sigstore_common_1.LogId.toJSON(message.logId);
			if (message.kindVersion !== void 0) obj.kindVersion = exports.KindVersion.toJSON(message.kindVersion);
			if (message.integratedTime !== "0") obj.integratedTime = message.integratedTime;
			if (message.inclusionPromise !== void 0) obj.inclusionPromise = exports.InclusionPromise.toJSON(message.inclusionPromise);
			if (message.inclusionProof !== void 0) obj.inclusionProof = exports.InclusionProof.toJSON(message.inclusionProof);
			if (message.canonicalizedBody.length !== 0) obj.canonicalizedBody = base64FromBytes(message.canonicalizedBody);
			return obj;
		}
	};
	function bytesFromBase64(b64) {
		return Uint8Array.from(globalThis.Buffer.from(b64, "base64"));
	}
	function base64FromBytes(arr) {
		return globalThis.Buffer.from(arr).toString("base64");
	}
	function isSet(value) {
		return value !== null && value !== void 0;
	}
}));
var require_sigstore_bundle = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Bundle = exports.VerificationMaterial = exports.TimestampVerificationData = void 0;
	const envelope_1 = require_envelope();
	const sigstore_common_1 = require_sigstore_common();
	const sigstore_rekor_1 = require_sigstore_rekor();
	exports.TimestampVerificationData = {
		fromJSON(object) {
			return { rfc3161Timestamps: globalThis.Array.isArray(object?.rfc3161Timestamps) ? object.rfc3161Timestamps.map((e) => sigstore_common_1.RFC3161SignedTimestamp.fromJSON(e)) : [] };
		},
		toJSON(message) {
			const obj = {};
			if (message.rfc3161Timestamps?.length) obj.rfc3161Timestamps = message.rfc3161Timestamps.map((e) => sigstore_common_1.RFC3161SignedTimestamp.toJSON(e));
			return obj;
		}
	};
	exports.VerificationMaterial = {
		fromJSON(object) {
			return {
				content: isSet(object.publicKey) ? {
					$case: "publicKey",
					publicKey: sigstore_common_1.PublicKeyIdentifier.fromJSON(object.publicKey)
				} : isSet(object.x509CertificateChain) ? {
					$case: "x509CertificateChain",
					x509CertificateChain: sigstore_common_1.X509CertificateChain.fromJSON(object.x509CertificateChain)
				} : isSet(object.certificate) ? {
					$case: "certificate",
					certificate: sigstore_common_1.X509Certificate.fromJSON(object.certificate)
				} : void 0,
				tlogEntries: globalThis.Array.isArray(object?.tlogEntries) ? object.tlogEntries.map((e) => sigstore_rekor_1.TransparencyLogEntry.fromJSON(e)) : [],
				timestampVerificationData: isSet(object.timestampVerificationData) ? exports.TimestampVerificationData.fromJSON(object.timestampVerificationData) : void 0
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.content?.$case === "publicKey") obj.publicKey = sigstore_common_1.PublicKeyIdentifier.toJSON(message.content.publicKey);
			else if (message.content?.$case === "x509CertificateChain") obj.x509CertificateChain = sigstore_common_1.X509CertificateChain.toJSON(message.content.x509CertificateChain);
			else if (message.content?.$case === "certificate") obj.certificate = sigstore_common_1.X509Certificate.toJSON(message.content.certificate);
			if (message.tlogEntries?.length) obj.tlogEntries = message.tlogEntries.map((e) => sigstore_rekor_1.TransparencyLogEntry.toJSON(e));
			if (message.timestampVerificationData !== void 0) obj.timestampVerificationData = exports.TimestampVerificationData.toJSON(message.timestampVerificationData);
			return obj;
		}
	};
	exports.Bundle = {
		fromJSON(object) {
			return {
				mediaType: isSet(object.mediaType) ? globalThis.String(object.mediaType) : "",
				verificationMaterial: isSet(object.verificationMaterial) ? exports.VerificationMaterial.fromJSON(object.verificationMaterial) : void 0,
				content: isSet(object.messageSignature) ? {
					$case: "messageSignature",
					messageSignature: sigstore_common_1.MessageSignature.fromJSON(object.messageSignature)
				} : isSet(object.dsseEnvelope) ? {
					$case: "dsseEnvelope",
					dsseEnvelope: envelope_1.Envelope.fromJSON(object.dsseEnvelope)
				} : void 0
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.mediaType !== "") obj.mediaType = message.mediaType;
			if (message.verificationMaterial !== void 0) obj.verificationMaterial = exports.VerificationMaterial.toJSON(message.verificationMaterial);
			if (message.content?.$case === "messageSignature") obj.messageSignature = sigstore_common_1.MessageSignature.toJSON(message.content.messageSignature);
			else if (message.content?.$case === "dsseEnvelope") obj.dsseEnvelope = envelope_1.Envelope.toJSON(message.content.dsseEnvelope);
			return obj;
		}
	};
	function isSet(value) {
		return value !== null && value !== void 0;
	}
}));
var require_sigstore_trustroot = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ClientTrustConfig = exports.ServiceConfiguration = exports.Service = exports.SigningConfig = exports.TrustedRoot = exports.CertificateAuthority = exports.TransparencyLogInstance = exports.ServiceSelector = void 0;
	exports.serviceSelectorFromJSON = serviceSelectorFromJSON;
	exports.serviceSelectorToJSON = serviceSelectorToJSON;
	const sigstore_common_1 = require_sigstore_common();
	/**
	* ServiceSelector specifies how a client SHOULD select a set of
	* Services to connect to. A client SHOULD throw an error if
	* the value is SERVICE_SELECTOR_UNDEFINED.
	*/
	var ServiceSelector;
	(function(ServiceSelector) {
		ServiceSelector[ServiceSelector["SERVICE_SELECTOR_UNDEFINED"] = 0] = "SERVICE_SELECTOR_UNDEFINED";
		/**
		* ALL - Clients SHOULD select all Services based on supported API version
		* and validity window.
		*/
		ServiceSelector[ServiceSelector["ALL"] = 1] = "ALL";
		/**
		* ANY - Clients SHOULD select one Service based on supported API version
		* and validity window. It is up to the client implementation to
		* decide how to select the Service, e.g. random or round-robin.
		*/
		ServiceSelector[ServiceSelector["ANY"] = 2] = "ANY";
		/**
		* EXACT - Clients SHOULD select a specific number of Services based on
		* supported API version and validity window, using the provided
		* `count`. It is up to the client implementation to decide how to
		* select the Service, e.g. random or round-robin.
		*/
		ServiceSelector[ServiceSelector["EXACT"] = 3] = "EXACT";
	})(ServiceSelector || (exports.ServiceSelector = ServiceSelector = {}));
	function serviceSelectorFromJSON(object) {
		switch (object) {
			case 0:
			case "SERVICE_SELECTOR_UNDEFINED": return ServiceSelector.SERVICE_SELECTOR_UNDEFINED;
			case 1:
			case "ALL": return ServiceSelector.ALL;
			case 2:
			case "ANY": return ServiceSelector.ANY;
			case 3:
			case "EXACT": return ServiceSelector.EXACT;
			default: throw new globalThis.Error("Unrecognized enum value " + object + " for enum ServiceSelector");
		}
	}
	function serviceSelectorToJSON(object) {
		switch (object) {
			case ServiceSelector.SERVICE_SELECTOR_UNDEFINED: return "SERVICE_SELECTOR_UNDEFINED";
			case ServiceSelector.ALL: return "ALL";
			case ServiceSelector.ANY: return "ANY";
			case ServiceSelector.EXACT: return "EXACT";
			default: throw new globalThis.Error("Unrecognized enum value " + object + " for enum ServiceSelector");
		}
	}
	exports.TransparencyLogInstance = {
		fromJSON(object) {
			return {
				baseUrl: isSet(object.baseUrl) ? globalThis.String(object.baseUrl) : "",
				hashAlgorithm: isSet(object.hashAlgorithm) ? (0, sigstore_common_1.hashAlgorithmFromJSON)(object.hashAlgorithm) : 0,
				publicKey: isSet(object.publicKey) ? sigstore_common_1.PublicKey.fromJSON(object.publicKey) : void 0,
				logId: isSet(object.logId) ? sigstore_common_1.LogId.fromJSON(object.logId) : void 0,
				checkpointKeyId: isSet(object.checkpointKeyId) ? sigstore_common_1.LogId.fromJSON(object.checkpointKeyId) : void 0,
				operator: isSet(object.operator) ? globalThis.String(object.operator) : ""
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.baseUrl !== "") obj.baseUrl = message.baseUrl;
			if (message.hashAlgorithm !== 0) obj.hashAlgorithm = (0, sigstore_common_1.hashAlgorithmToJSON)(message.hashAlgorithm);
			if (message.publicKey !== void 0) obj.publicKey = sigstore_common_1.PublicKey.toJSON(message.publicKey);
			if (message.logId !== void 0) obj.logId = sigstore_common_1.LogId.toJSON(message.logId);
			if (message.checkpointKeyId !== void 0) obj.checkpointKeyId = sigstore_common_1.LogId.toJSON(message.checkpointKeyId);
			if (message.operator !== "") obj.operator = message.operator;
			return obj;
		}
	};
	exports.CertificateAuthority = {
		fromJSON(object) {
			return {
				subject: isSet(object.subject) ? sigstore_common_1.DistinguishedName.fromJSON(object.subject) : void 0,
				uri: isSet(object.uri) ? globalThis.String(object.uri) : "",
				certChain: isSet(object.certChain) ? sigstore_common_1.X509CertificateChain.fromJSON(object.certChain) : void 0,
				validFor: isSet(object.validFor) ? sigstore_common_1.TimeRange.fromJSON(object.validFor) : void 0,
				operator: isSet(object.operator) ? globalThis.String(object.operator) : ""
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.subject !== void 0) obj.subject = sigstore_common_1.DistinguishedName.toJSON(message.subject);
			if (message.uri !== "") obj.uri = message.uri;
			if (message.certChain !== void 0) obj.certChain = sigstore_common_1.X509CertificateChain.toJSON(message.certChain);
			if (message.validFor !== void 0) obj.validFor = sigstore_common_1.TimeRange.toJSON(message.validFor);
			if (message.operator !== "") obj.operator = message.operator;
			return obj;
		}
	};
	exports.TrustedRoot = {
		fromJSON(object) {
			return {
				mediaType: isSet(object.mediaType) ? globalThis.String(object.mediaType) : "",
				tlogs: globalThis.Array.isArray(object?.tlogs) ? object.tlogs.map((e) => exports.TransparencyLogInstance.fromJSON(e)) : [],
				certificateAuthorities: globalThis.Array.isArray(object?.certificateAuthorities) ? object.certificateAuthorities.map((e) => exports.CertificateAuthority.fromJSON(e)) : [],
				ctlogs: globalThis.Array.isArray(object?.ctlogs) ? object.ctlogs.map((e) => exports.TransparencyLogInstance.fromJSON(e)) : [],
				timestampAuthorities: globalThis.Array.isArray(object?.timestampAuthorities) ? object.timestampAuthorities.map((e) => exports.CertificateAuthority.fromJSON(e)) : []
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.mediaType !== "") obj.mediaType = message.mediaType;
			if (message.tlogs?.length) obj.tlogs = message.tlogs.map((e) => exports.TransparencyLogInstance.toJSON(e));
			if (message.certificateAuthorities?.length) obj.certificateAuthorities = message.certificateAuthorities.map((e) => exports.CertificateAuthority.toJSON(e));
			if (message.ctlogs?.length) obj.ctlogs = message.ctlogs.map((e) => exports.TransparencyLogInstance.toJSON(e));
			if (message.timestampAuthorities?.length) obj.timestampAuthorities = message.timestampAuthorities.map((e) => exports.CertificateAuthority.toJSON(e));
			return obj;
		}
	};
	exports.SigningConfig = {
		fromJSON(object) {
			return {
				mediaType: isSet(object.mediaType) ? globalThis.String(object.mediaType) : "",
				caUrls: globalThis.Array.isArray(object?.caUrls) ? object.caUrls.map((e) => exports.Service.fromJSON(e)) : [],
				oidcUrls: globalThis.Array.isArray(object?.oidcUrls) ? object.oidcUrls.map((e) => exports.Service.fromJSON(e)) : [],
				rekorTlogUrls: globalThis.Array.isArray(object?.rekorTlogUrls) ? object.rekorTlogUrls.map((e) => exports.Service.fromJSON(e)) : [],
				rekorTlogConfig: isSet(object.rekorTlogConfig) ? exports.ServiceConfiguration.fromJSON(object.rekorTlogConfig) : void 0,
				tsaUrls: globalThis.Array.isArray(object?.tsaUrls) ? object.tsaUrls.map((e) => exports.Service.fromJSON(e)) : [],
				tsaConfig: isSet(object.tsaConfig) ? exports.ServiceConfiguration.fromJSON(object.tsaConfig) : void 0
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.mediaType !== "") obj.mediaType = message.mediaType;
			if (message.caUrls?.length) obj.caUrls = message.caUrls.map((e) => exports.Service.toJSON(e));
			if (message.oidcUrls?.length) obj.oidcUrls = message.oidcUrls.map((e) => exports.Service.toJSON(e));
			if (message.rekorTlogUrls?.length) obj.rekorTlogUrls = message.rekorTlogUrls.map((e) => exports.Service.toJSON(e));
			if (message.rekorTlogConfig !== void 0) obj.rekorTlogConfig = exports.ServiceConfiguration.toJSON(message.rekorTlogConfig);
			if (message.tsaUrls?.length) obj.tsaUrls = message.tsaUrls.map((e) => exports.Service.toJSON(e));
			if (message.tsaConfig !== void 0) obj.tsaConfig = exports.ServiceConfiguration.toJSON(message.tsaConfig);
			return obj;
		}
	};
	exports.Service = {
		fromJSON(object) {
			return {
				url: isSet(object.url) ? globalThis.String(object.url) : "",
				majorApiVersion: isSet(object.majorApiVersion) ? globalThis.Number(object.majorApiVersion) : 0,
				validFor: isSet(object.validFor) ? sigstore_common_1.TimeRange.fromJSON(object.validFor) : void 0,
				operator: isSet(object.operator) ? globalThis.String(object.operator) : ""
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.url !== "") obj.url = message.url;
			if (message.majorApiVersion !== 0) obj.majorApiVersion = Math.round(message.majorApiVersion);
			if (message.validFor !== void 0) obj.validFor = sigstore_common_1.TimeRange.toJSON(message.validFor);
			if (message.operator !== "") obj.operator = message.operator;
			return obj;
		}
	};
	exports.ServiceConfiguration = {
		fromJSON(object) {
			return {
				selector: isSet(object.selector) ? serviceSelectorFromJSON(object.selector) : 0,
				count: isSet(object.count) ? globalThis.Number(object.count) : 0
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.selector !== 0) obj.selector = serviceSelectorToJSON(message.selector);
			if (message.count !== 0) obj.count = Math.round(message.count);
			return obj;
		}
	};
	exports.ClientTrustConfig = {
		fromJSON(object) {
			return {
				mediaType: isSet(object.mediaType) ? globalThis.String(object.mediaType) : "",
				trustedRoot: isSet(object.trustedRoot) ? exports.TrustedRoot.fromJSON(object.trustedRoot) : void 0,
				signingConfig: isSet(object.signingConfig) ? exports.SigningConfig.fromJSON(object.signingConfig) : void 0
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.mediaType !== "") obj.mediaType = message.mediaType;
			if (message.trustedRoot !== void 0) obj.trustedRoot = exports.TrustedRoot.toJSON(message.trustedRoot);
			if (message.signingConfig !== void 0) obj.signingConfig = exports.SigningConfig.toJSON(message.signingConfig);
			return obj;
		}
	};
	function isSet(value) {
		return value !== null && value !== void 0;
	}
}));
var require_sigstore_verification = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Input = exports.Artifact = exports.ArtifactVerificationOptions_ObserverTimestampOptions = exports.ArtifactVerificationOptions_TlogIntegratedTimestampOptions = exports.ArtifactVerificationOptions_TimestampAuthorityOptions = exports.ArtifactVerificationOptions_CtlogOptions = exports.ArtifactVerificationOptions_TlogOptions = exports.ArtifactVerificationOptions = exports.PublicKeyIdentities = exports.CertificateIdentities = exports.CertificateIdentity = void 0;
	const sigstore_bundle_1 = require_sigstore_bundle();
	const sigstore_common_1 = require_sigstore_common();
	const sigstore_trustroot_1 = require_sigstore_trustroot();
	exports.CertificateIdentity = {
		fromJSON(object) {
			return {
				issuer: isSet(object.issuer) ? globalThis.String(object.issuer) : "",
				san: isSet(object.san) ? sigstore_common_1.SubjectAlternativeName.fromJSON(object.san) : void 0,
				oids: globalThis.Array.isArray(object?.oids) ? object.oids.map((e) => sigstore_common_1.ObjectIdentifierValuePair.fromJSON(e)) : []
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.issuer !== "") obj.issuer = message.issuer;
			if (message.san !== void 0) obj.san = sigstore_common_1.SubjectAlternativeName.toJSON(message.san);
			if (message.oids?.length) obj.oids = message.oids.map((e) => sigstore_common_1.ObjectIdentifierValuePair.toJSON(e));
			return obj;
		}
	};
	exports.CertificateIdentities = {
		fromJSON(object) {
			return { identities: globalThis.Array.isArray(object?.identities) ? object.identities.map((e) => exports.CertificateIdentity.fromJSON(e)) : [] };
		},
		toJSON(message) {
			const obj = {};
			if (message.identities?.length) obj.identities = message.identities.map((e) => exports.CertificateIdentity.toJSON(e));
			return obj;
		}
	};
	exports.PublicKeyIdentities = {
		fromJSON(object) {
			return { publicKeys: globalThis.Array.isArray(object?.publicKeys) ? object.publicKeys.map((e) => sigstore_common_1.PublicKey.fromJSON(e)) : [] };
		},
		toJSON(message) {
			const obj = {};
			if (message.publicKeys?.length) obj.publicKeys = message.publicKeys.map((e) => sigstore_common_1.PublicKey.toJSON(e));
			return obj;
		}
	};
	exports.ArtifactVerificationOptions = {
		fromJSON(object) {
			return {
				signers: isSet(object.certificateIdentities) ? {
					$case: "certificateIdentities",
					certificateIdentities: exports.CertificateIdentities.fromJSON(object.certificateIdentities)
				} : isSet(object.publicKeys) ? {
					$case: "publicKeys",
					publicKeys: exports.PublicKeyIdentities.fromJSON(object.publicKeys)
				} : void 0,
				tlogOptions: isSet(object.tlogOptions) ? exports.ArtifactVerificationOptions_TlogOptions.fromJSON(object.tlogOptions) : void 0,
				ctlogOptions: isSet(object.ctlogOptions) ? exports.ArtifactVerificationOptions_CtlogOptions.fromJSON(object.ctlogOptions) : void 0,
				tsaOptions: isSet(object.tsaOptions) ? exports.ArtifactVerificationOptions_TimestampAuthorityOptions.fromJSON(object.tsaOptions) : void 0,
				integratedTsOptions: isSet(object.integratedTsOptions) ? exports.ArtifactVerificationOptions_TlogIntegratedTimestampOptions.fromJSON(object.integratedTsOptions) : void 0,
				observerOptions: isSet(object.observerOptions) ? exports.ArtifactVerificationOptions_ObserverTimestampOptions.fromJSON(object.observerOptions) : void 0
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.signers?.$case === "certificateIdentities") obj.certificateIdentities = exports.CertificateIdentities.toJSON(message.signers.certificateIdentities);
			else if (message.signers?.$case === "publicKeys") obj.publicKeys = exports.PublicKeyIdentities.toJSON(message.signers.publicKeys);
			if (message.tlogOptions !== void 0) obj.tlogOptions = exports.ArtifactVerificationOptions_TlogOptions.toJSON(message.tlogOptions);
			if (message.ctlogOptions !== void 0) obj.ctlogOptions = exports.ArtifactVerificationOptions_CtlogOptions.toJSON(message.ctlogOptions);
			if (message.tsaOptions !== void 0) obj.tsaOptions = exports.ArtifactVerificationOptions_TimestampAuthorityOptions.toJSON(message.tsaOptions);
			if (message.integratedTsOptions !== void 0) obj.integratedTsOptions = exports.ArtifactVerificationOptions_TlogIntegratedTimestampOptions.toJSON(message.integratedTsOptions);
			if (message.observerOptions !== void 0) obj.observerOptions = exports.ArtifactVerificationOptions_ObserverTimestampOptions.toJSON(message.observerOptions);
			return obj;
		}
	};
	exports.ArtifactVerificationOptions_TlogOptions = {
		fromJSON(object) {
			return {
				threshold: isSet(object.threshold) ? globalThis.Number(object.threshold) : 0,
				performOnlineVerification: isSet(object.performOnlineVerification) ? globalThis.Boolean(object.performOnlineVerification) : false,
				disable: isSet(object.disable) ? globalThis.Boolean(object.disable) : false
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.threshold !== 0) obj.threshold = Math.round(message.threshold);
			if (message.performOnlineVerification !== false) obj.performOnlineVerification = message.performOnlineVerification;
			if (message.disable !== false) obj.disable = message.disable;
			return obj;
		}
	};
	exports.ArtifactVerificationOptions_CtlogOptions = {
		fromJSON(object) {
			return {
				threshold: isSet(object.threshold) ? globalThis.Number(object.threshold) : 0,
				disable: isSet(object.disable) ? globalThis.Boolean(object.disable) : false
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.threshold !== 0) obj.threshold = Math.round(message.threshold);
			if (message.disable !== false) obj.disable = message.disable;
			return obj;
		}
	};
	exports.ArtifactVerificationOptions_TimestampAuthorityOptions = {
		fromJSON(object) {
			return {
				threshold: isSet(object.threshold) ? globalThis.Number(object.threshold) : 0,
				disable: isSet(object.disable) ? globalThis.Boolean(object.disable) : false
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.threshold !== 0) obj.threshold = Math.round(message.threshold);
			if (message.disable !== false) obj.disable = message.disable;
			return obj;
		}
	};
	exports.ArtifactVerificationOptions_TlogIntegratedTimestampOptions = {
		fromJSON(object) {
			return {
				threshold: isSet(object.threshold) ? globalThis.Number(object.threshold) : 0,
				disable: isSet(object.disable) ? globalThis.Boolean(object.disable) : false
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.threshold !== 0) obj.threshold = Math.round(message.threshold);
			if (message.disable !== false) obj.disable = message.disable;
			return obj;
		}
	};
	exports.ArtifactVerificationOptions_ObserverTimestampOptions = {
		fromJSON(object) {
			return {
				threshold: isSet(object.threshold) ? globalThis.Number(object.threshold) : 0,
				disable: isSet(object.disable) ? globalThis.Boolean(object.disable) : false
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.threshold !== 0) obj.threshold = Math.round(message.threshold);
			if (message.disable !== false) obj.disable = message.disable;
			return obj;
		}
	};
	exports.Artifact = {
		fromJSON(object) {
			return { data: isSet(object.artifactUri) ? {
				$case: "artifactUri",
				artifactUri: globalThis.String(object.artifactUri)
			} : isSet(object.artifact) ? {
				$case: "artifact",
				artifact: Buffer.from(bytesFromBase64(object.artifact))
			} : isSet(object.artifactDigest) ? {
				$case: "artifactDigest",
				artifactDigest: sigstore_common_1.HashOutput.fromJSON(object.artifactDigest)
			} : void 0 };
		},
		toJSON(message) {
			const obj = {};
			if (message.data?.$case === "artifactUri") obj.artifactUri = message.data.artifactUri;
			else if (message.data?.$case === "artifact") obj.artifact = base64FromBytes(message.data.artifact);
			else if (message.data?.$case === "artifactDigest") obj.artifactDigest = sigstore_common_1.HashOutput.toJSON(message.data.artifactDigest);
			return obj;
		}
	};
	exports.Input = {
		fromJSON(object) {
			return {
				artifactTrustRoot: isSet(object.artifactTrustRoot) ? sigstore_trustroot_1.TrustedRoot.fromJSON(object.artifactTrustRoot) : void 0,
				artifactVerificationOptions: isSet(object.artifactVerificationOptions) ? exports.ArtifactVerificationOptions.fromJSON(object.artifactVerificationOptions) : void 0,
				bundle: isSet(object.bundle) ? sigstore_bundle_1.Bundle.fromJSON(object.bundle) : void 0,
				artifact: isSet(object.artifact) ? exports.Artifact.fromJSON(object.artifact) : void 0
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.artifactTrustRoot !== void 0) obj.artifactTrustRoot = sigstore_trustroot_1.TrustedRoot.toJSON(message.artifactTrustRoot);
			if (message.artifactVerificationOptions !== void 0) obj.artifactVerificationOptions = exports.ArtifactVerificationOptions.toJSON(message.artifactVerificationOptions);
			if (message.bundle !== void 0) obj.bundle = sigstore_bundle_1.Bundle.toJSON(message.bundle);
			if (message.artifact !== void 0) obj.artifact = exports.Artifact.toJSON(message.artifact);
			return obj;
		}
	};
	function bytesFromBase64(b64) {
		return Uint8Array.from(globalThis.Buffer.from(b64, "base64"));
	}
	function base64FromBytes(arr) {
		return globalThis.Buffer.from(arr).toString("base64");
	}
	function isSet(value) {
		return value !== null && value !== void 0;
	}
}));
var require_dist$3 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __exportStar = exports && exports.__exportStar || function(m, exports$2) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$2, p)) __createBinding(exports$2, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	__exportStar(require_envelope(), exports);
	__exportStar(require_sigstore_bundle(), exports);
	__exportStar(require_sigstore_common(), exports);
	__exportStar(require_sigstore_rekor(), exports);
	__exportStar(require_sigstore_trustroot(), exports);
	__exportStar(require_sigstore_verification(), exports);
}));
var require_bundle$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.BUNDLE_V03_MEDIA_TYPE = exports.BUNDLE_V03_LEGACY_MEDIA_TYPE = exports.BUNDLE_V02_MEDIA_TYPE = exports.BUNDLE_V01_MEDIA_TYPE = void 0;
	exports.isBundleWithCertificateChain = isBundleWithCertificateChain;
	exports.isBundleWithPublicKey = isBundleWithPublicKey;
	exports.isBundleWithMessageSignature = isBundleWithMessageSignature;
	exports.isBundleWithDsseEnvelope = isBundleWithDsseEnvelope;
	exports.BUNDLE_V01_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle+json;version=0.1";
	exports.BUNDLE_V02_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle+json;version=0.2";
	exports.BUNDLE_V03_LEGACY_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle+json;version=0.3";
	exports.BUNDLE_V03_MEDIA_TYPE = "application/vnd.dev.sigstore.bundle.v0.3+json";
	function isBundleWithCertificateChain(b) {
		return b.verificationMaterial.content.$case === "x509CertificateChain";
	}
	function isBundleWithPublicKey(b) {
		return b.verificationMaterial.content.$case === "publicKey";
	}
	function isBundleWithMessageSignature(b) {
		return b.content.$case === "messageSignature";
	}
	function isBundleWithDsseEnvelope(b) {
		return b.content.$case === "dsseEnvelope";
	}
}));
var require_build = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.toMessageSignatureBundle = toMessageSignatureBundle;
	exports.toDSSEBundle = toDSSEBundle;
	const protobuf_specs_1 = require_dist$3();
	const bundle_1 = require_bundle$1();
	function toMessageSignatureBundle(options) {
		return {
			mediaType: options.certificateChain ? bundle_1.BUNDLE_V02_MEDIA_TYPE : bundle_1.BUNDLE_V03_MEDIA_TYPE,
			content: {
				$case: "messageSignature",
				messageSignature: {
					messageDigest: {
						algorithm: protobuf_specs_1.HashAlgorithm.SHA2_256,
						digest: options.digest
					},
					signature: options.signature
				}
			},
			verificationMaterial: toVerificationMaterial(options)
		};
	}
	function toDSSEBundle(options) {
		return {
			mediaType: options.certificateChain ? bundle_1.BUNDLE_V02_MEDIA_TYPE : bundle_1.BUNDLE_V03_MEDIA_TYPE,
			content: {
				$case: "dsseEnvelope",
				dsseEnvelope: toEnvelope(options)
			},
			verificationMaterial: toVerificationMaterial(options)
		};
	}
	function toEnvelope(options) {
		return {
			payloadType: options.artifactType,
			payload: options.artifact,
			signatures: [toSignature(options)]
		};
	}
	function toSignature(options) {
		return {
			keyid: options.keyHint || "",
			sig: options.signature
		};
	}
	function toVerificationMaterial(options) {
		return {
			content: toKeyContent(options),
			tlogEntries: [],
			timestampVerificationData: { rfc3161Timestamps: [] }
		};
	}
	function toKeyContent(options) {
		if (options.certificate) if (options.certificateChain) return {
			$case: "x509CertificateChain",
			x509CertificateChain: { certificates: [{ rawBytes: options.certificate }] }
		};
		else return {
			$case: "certificate",
			certificate: { rawBytes: options.certificate }
		};
		else return {
			$case: "publicKey",
			publicKey: { hint: options.keyHint || "" }
		};
	}
}));
var require_error$3 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ValidationError = void 0;
	var ValidationError = class extends Error {
		fields;
		constructor(message, fields) {
			super(message);
			this.fields = fields;
		}
	};
	exports.ValidationError = ValidationError;
}));
var require_validate = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.assertBundle = assertBundle;
	exports.assertBundleV01 = assertBundleV01;
	exports.isBundleV01 = isBundleV01;
	exports.assertBundleV02 = assertBundleV02;
	exports.assertBundleLatest = assertBundleLatest;
	const error_1 = require_error$3();
	function assertBundle(b) {
		const invalidValues = validateBundleBase(b);
		if (invalidValues.length > 0) throw new error_1.ValidationError("invalid bundle", invalidValues);
	}
	function assertBundleV01(b) {
		const invalidValues = [];
		invalidValues.push(...validateBundleBase(b));
		invalidValues.push(...validateInclusionPromise(b));
		if (invalidValues.length > 0) throw new error_1.ValidationError("invalid v0.1 bundle", invalidValues);
	}
	function isBundleV01(b) {
		try {
			assertBundleV01(b);
			return true;
		} catch (e) {
			return false;
		}
	}
	function assertBundleV02(b) {
		const invalidValues = [];
		invalidValues.push(...validateBundleBase(b));
		invalidValues.push(...validateInclusionProof(b));
		if (invalidValues.length > 0) throw new error_1.ValidationError("invalid v0.2 bundle", invalidValues);
	}
	function assertBundleLatest(b) {
		const invalidValues = [];
		invalidValues.push(...validateBundleBase(b));
		invalidValues.push(...validateInclusionProof(b));
		invalidValues.push(...validateNoCertificateChain(b));
		if (invalidValues.length > 0) throw new error_1.ValidationError("invalid bundle", invalidValues);
	}
	function validateBundleBase(b) {
		const invalidValues = [];
		if (b.mediaType === void 0 || !b.mediaType.match(/^application\/vnd\.dev\.sigstore\.bundle\+json;version=\d\.\d/) && !b.mediaType.match(/^application\/vnd\.dev\.sigstore\.bundle\.v\d\.\d\+json/)) invalidValues.push("mediaType");
		if (b.content === void 0) invalidValues.push("content");
		else switch (b.content.$case) {
			case "messageSignature":
				if (b.content.messageSignature.messageDigest === void 0) invalidValues.push("content.messageSignature.messageDigest");
				else if (b.content.messageSignature.messageDigest.digest.length === 0) invalidValues.push("content.messageSignature.messageDigest.digest");
				if (b.content.messageSignature.signature.length === 0) invalidValues.push("content.messageSignature.signature");
				break;
			case "dsseEnvelope":
				if (b.content.dsseEnvelope.payload.length === 0) invalidValues.push("content.dsseEnvelope.payload");
				if (b.content.dsseEnvelope.signatures.length !== 1) invalidValues.push("content.dsseEnvelope.signatures");
				else if (b.content.dsseEnvelope.signatures[0].sig.length === 0) invalidValues.push("content.dsseEnvelope.signatures[0].sig");
				break;
		}
		if (b.verificationMaterial === void 0) invalidValues.push("verificationMaterial");
		else {
			if (b.verificationMaterial.content === void 0) invalidValues.push("verificationMaterial.content");
			else switch (b.verificationMaterial.content.$case) {
				case "x509CertificateChain":
					if (b.verificationMaterial.content.x509CertificateChain.certificates.length === 0) invalidValues.push("verificationMaterial.content.x509CertificateChain.certificates");
					b.verificationMaterial.content.x509CertificateChain.certificates.forEach((cert, i) => {
						if (cert.rawBytes.length === 0) invalidValues.push(`verificationMaterial.content.x509CertificateChain.certificates[${i}].rawBytes`);
					});
					break;
				case "certificate":
					if (b.verificationMaterial.content.certificate.rawBytes.length === 0) invalidValues.push("verificationMaterial.content.certificate.rawBytes");
					break;
			}
			if (b.verificationMaterial.tlogEntries === void 0) invalidValues.push("verificationMaterial.tlogEntries");
			else if (b.verificationMaterial.tlogEntries.length > 0) b.verificationMaterial.tlogEntries.forEach((entry, i) => {
				if (entry.logId === void 0) invalidValues.push(`verificationMaterial.tlogEntries[${i}].logId`);
				if (entry.kindVersion === void 0) invalidValues.push(`verificationMaterial.tlogEntries[${i}].kindVersion`);
			});
		}
		return invalidValues;
	}
	function validateInclusionPromise(b) {
		const invalidValues = [];
		if (b.verificationMaterial && b.verificationMaterial.tlogEntries?.length > 0) b.verificationMaterial.tlogEntries.forEach((entry, i) => {
			if (entry.inclusionPromise === void 0) invalidValues.push(`verificationMaterial.tlogEntries[${i}].inclusionPromise`);
		});
		return invalidValues;
	}
	function validateInclusionProof(b) {
		const invalidValues = [];
		if (b.verificationMaterial && b.verificationMaterial.tlogEntries?.length > 0) b.verificationMaterial.tlogEntries.forEach((entry, i) => {
			if (entry.inclusionProof === void 0) invalidValues.push(`verificationMaterial.tlogEntries[${i}].inclusionProof`);
			else if (entry.inclusionProof.checkpoint === void 0) invalidValues.push(`verificationMaterial.tlogEntries[${i}].inclusionProof.checkpoint`);
		});
		return invalidValues;
	}
	function validateNoCertificateChain(b) {
		const invalidValues = [];
		/* istanbul ignore next */
		if (b.verificationMaterial?.content?.$case === "x509CertificateChain") invalidValues.push("verificationMaterial.content.$case");
		return invalidValues;
	}
}));
var require_serialized = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.envelopeToJSON = exports.envelopeFromJSON = exports.bundleToJSON = exports.bundleFromJSON = void 0;
	const protobuf_specs_1 = require_dist$3();
	const bundle_1 = require_bundle$1();
	const validate_1 = require_validate();
	const bundleFromJSON = (obj) => {
		const bundle = protobuf_specs_1.Bundle.fromJSON(obj);
		switch (bundle.mediaType) {
			case bundle_1.BUNDLE_V01_MEDIA_TYPE:
				(0, validate_1.assertBundleV01)(bundle);
				break;
			case bundle_1.BUNDLE_V02_MEDIA_TYPE:
				(0, validate_1.assertBundleV02)(bundle);
				break;
			default:
				(0, validate_1.assertBundleLatest)(bundle);
				break;
		}
		return bundle;
	};
	exports.bundleFromJSON = bundleFromJSON;
	const bundleToJSON = (bundle) => {
		return protobuf_specs_1.Bundle.toJSON(bundle);
	};
	exports.bundleToJSON = bundleToJSON;
	const envelopeFromJSON = (obj) => {
		return protobuf_specs_1.Envelope.fromJSON(obj);
	};
	exports.envelopeFromJSON = envelopeFromJSON;
	const envelopeToJSON = (envelope) => {
		return protobuf_specs_1.Envelope.toJSON(envelope);
	};
	exports.envelopeToJSON = envelopeToJSON;
}));
var require_dist$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.isBundleV01 = exports.assertBundleV02 = exports.assertBundleV01 = exports.assertBundleLatest = exports.assertBundle = exports.envelopeToJSON = exports.envelopeFromJSON = exports.bundleToJSON = exports.bundleFromJSON = exports.ValidationError = exports.isBundleWithPublicKey = exports.isBundleWithMessageSignature = exports.isBundleWithDsseEnvelope = exports.isBundleWithCertificateChain = exports.BUNDLE_V03_MEDIA_TYPE = exports.BUNDLE_V03_LEGACY_MEDIA_TYPE = exports.BUNDLE_V02_MEDIA_TYPE = exports.BUNDLE_V01_MEDIA_TYPE = exports.toMessageSignatureBundle = exports.toDSSEBundle = void 0;
	var build_1 = require_build();
	Object.defineProperty(exports, "toDSSEBundle", {
		enumerable: true,
		get: function() {
			return build_1.toDSSEBundle;
		}
	});
	Object.defineProperty(exports, "toMessageSignatureBundle", {
		enumerable: true,
		get: function() {
			return build_1.toMessageSignatureBundle;
		}
	});
	var bundle_1 = require_bundle$1();
	Object.defineProperty(exports, "BUNDLE_V01_MEDIA_TYPE", {
		enumerable: true,
		get: function() {
			return bundle_1.BUNDLE_V01_MEDIA_TYPE;
		}
	});
	Object.defineProperty(exports, "BUNDLE_V02_MEDIA_TYPE", {
		enumerable: true,
		get: function() {
			return bundle_1.BUNDLE_V02_MEDIA_TYPE;
		}
	});
	Object.defineProperty(exports, "BUNDLE_V03_LEGACY_MEDIA_TYPE", {
		enumerable: true,
		get: function() {
			return bundle_1.BUNDLE_V03_LEGACY_MEDIA_TYPE;
		}
	});
	Object.defineProperty(exports, "BUNDLE_V03_MEDIA_TYPE", {
		enumerable: true,
		get: function() {
			return bundle_1.BUNDLE_V03_MEDIA_TYPE;
		}
	});
	Object.defineProperty(exports, "isBundleWithCertificateChain", {
		enumerable: true,
		get: function() {
			return bundle_1.isBundleWithCertificateChain;
		}
	});
	Object.defineProperty(exports, "isBundleWithDsseEnvelope", {
		enumerable: true,
		get: function() {
			return bundle_1.isBundleWithDsseEnvelope;
		}
	});
	Object.defineProperty(exports, "isBundleWithMessageSignature", {
		enumerable: true,
		get: function() {
			return bundle_1.isBundleWithMessageSignature;
		}
	});
	Object.defineProperty(exports, "isBundleWithPublicKey", {
		enumerable: true,
		get: function() {
			return bundle_1.isBundleWithPublicKey;
		}
	});
	var error_1 = require_error$3();
	Object.defineProperty(exports, "ValidationError", {
		enumerable: true,
		get: function() {
			return error_1.ValidationError;
		}
	});
	var serialized_1 = require_serialized();
	Object.defineProperty(exports, "bundleFromJSON", {
		enumerable: true,
		get: function() {
			return serialized_1.bundleFromJSON;
		}
	});
	Object.defineProperty(exports, "bundleToJSON", {
		enumerable: true,
		get: function() {
			return serialized_1.bundleToJSON;
		}
	});
	Object.defineProperty(exports, "envelopeFromJSON", {
		enumerable: true,
		get: function() {
			return serialized_1.envelopeFromJSON;
		}
	});
	Object.defineProperty(exports, "envelopeToJSON", {
		enumerable: true,
		get: function() {
			return serialized_1.envelopeToJSON;
		}
	});
	var validate_1 = require_validate();
	Object.defineProperty(exports, "assertBundle", {
		enumerable: true,
		get: function() {
			return validate_1.assertBundle;
		}
	});
	Object.defineProperty(exports, "assertBundleLatest", {
		enumerable: true,
		get: function() {
			return validate_1.assertBundleLatest;
		}
	});
	Object.defineProperty(exports, "assertBundleV01", {
		enumerable: true,
		get: function() {
			return validate_1.assertBundleV01;
		}
	});
	Object.defineProperty(exports, "assertBundleV02", {
		enumerable: true,
		get: function() {
			return validate_1.assertBundleV02;
		}
	});
	Object.defineProperty(exports, "isBundleV01", {
		enumerable: true,
		get: function() {
			return validate_1.isBundleV01;
		}
	});
}));
var require_stream = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ByteStream = void 0;
	var StreamError = class extends Error {};
	exports.ByteStream = class ByteStream {
		static BLOCK_SIZE = 1024;
		buf;
		view;
		start = 0;
		constructor(buffer) {
			if (buffer) {
				this.buf = buffer;
				this.view = Buffer.from(buffer);
			} else {
				this.buf = Buffer.alloc(0);
				this.view = Buffer.from(this.buf);
			}
		}
		get buffer() {
			return this.view.subarray(0, this.start);
		}
		get length() {
			return this.view.byteLength;
		}
		get position() {
			return this.start;
		}
		seek(position) {
			this.start = position;
		}
		slice(start, len) {
			const end = start + len;
			if (end > this.length) throw new StreamError("request past end of buffer");
			return this.view.subarray(start, end);
		}
		appendChar(char) {
			this.ensureCapacity(1);
			this.view[this.start] = char;
			this.start += 1;
		}
		appendUint16(num) {
			this.ensureCapacity(2);
			const value = new Uint16Array([num]);
			const view = new Uint8Array(value.buffer);
			this.view[this.start] = view[1];
			this.view[this.start + 1] = view[0];
			this.start += 2;
		}
		appendUint24(num) {
			this.ensureCapacity(3);
			const value = new Uint32Array([num]);
			const view = new Uint8Array(value.buffer);
			this.view[this.start] = view[2];
			this.view[this.start + 1] = view[1];
			this.view[this.start + 2] = view[0];
			this.start += 3;
		}
		appendView(view) {
			this.ensureCapacity(view.length);
			this.view.set(view, this.start);
			this.start += view.length;
		}
		getBlock(size) {
			if (size <= 0) return Buffer.alloc(0);
			if (this.start + size > this.view.length) throw new Error("request past end of buffer");
			const result = this.view.subarray(this.start, this.start + size);
			this.start += size;
			return result;
		}
		getUint8() {
			return this.getBlock(1)[0];
		}
		getUint16() {
			const block = this.getBlock(2);
			return block[0] << 8 | block[1];
		}
		ensureCapacity(size) {
			if (this.start + size > this.view.byteLength) {
				const blockSize = ByteStream.BLOCK_SIZE + (size > ByteStream.BLOCK_SIZE ? size : 0);
				this.realloc(this.view.byteLength + blockSize);
			}
		}
		realloc(size) {
			const newArray = Buffer.alloc(size);
			const newView = Buffer.from(newArray);
			newView.set(this.view);
			this.buf = newArray;
			this.view = newView;
		}
	};
}));
var require_error$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ASN1TypeError = exports.ASN1ParseError = void 0;
	var ASN1ParseError = class extends Error {};
	exports.ASN1ParseError = ASN1ParseError;
	var ASN1TypeError = class extends Error {};
	exports.ASN1TypeError = ASN1TypeError;
}));
var require_length = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.decodeLength = decodeLength;
	exports.encodeLength = encodeLength;
	const error_1 = require_error$2();
	function decodeLength(stream) {
		const buf = stream.getUint8();
		if ((buf & 128) === 0) return buf;
		const byteCount = buf & 127;
		if (byteCount > 6) throw new error_1.ASN1ParseError("length exceeds 6 byte limit");
		let len = 0;
		for (let i = 0; i < byteCount; i++) {
			const byte = stream.getUint8();
			if (i === 0 && byte === 0) throw new error_1.ASN1ParseError("non-minimal length encoding");
			len = len * 256 + byte;
		}
		if (len === 0) throw new error_1.ASN1ParseError("indefinite length encoding not supported");
		if (len < 128) throw new error_1.ASN1ParseError("non-minimal length encoding");
		return len;
	}
	function encodeLength(len) {
		if (len < 128) return Buffer.from([len]);
		let val = BigInt(len);
		const bytes = [];
		while (val > 0n) {
			bytes.unshift(Number(val & 255n));
			val = val >> 8n;
		}
		return Buffer.from([128 | bytes.length, ...bytes]);
	}
}));
var require_parse = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.parseInteger = parseInteger;
	exports.parseStringASCII = parseStringASCII;
	exports.parseTime = parseTime;
	exports.parseOID = parseOID;
	exports.parseBoolean = parseBoolean;
	exports.parseBitString = parseBitString;
	const error_1 = require_error$2();
	const RE_TIME_SHORT_YEAR = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d{3})?Z$/;
	const RE_TIME_LONG_YEAR = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\.\d{3})?Z$/;
	function parseInteger(buf) {
		let pos = 0;
		const end = buf.length;
		let val = buf[pos];
		const neg = val > 127;
		const pad = neg ? 255 : 0;
		while (val == pad && ++pos < end) val = buf[pos];
		if (end - pos === 0) return BigInt(neg ? -1 : 0);
		val = neg ? val - 256 : val;
		let n = BigInt(val);
		for (let i = pos + 1; i < end; ++i) n = n * BigInt(256) + BigInt(buf[i]);
		return n;
	}
	function parseStringASCII(buf) {
		return buf.toString("ascii");
	}
	function parseTime(buf, shortYear) {
		const timeStr = parseStringASCII(buf);
		const m = shortYear ? RE_TIME_SHORT_YEAR.exec(timeStr) : RE_TIME_LONG_YEAR.exec(timeStr);
		if (!m) throw new Error("invalid time");
		if (shortYear) {
			let year = Number(m[1]);
			year += year >= 50 ? 1900 : 2e3;
			m[1] = year.toString();
		}
		return /* @__PURE__ */ new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}Z`);
	}
	function parseOID(buf) {
		let pos = 0;
		const end = buf.length;
		let n = buf[pos++];
		let oid = `${Math.floor(n / 40)}.${n % 40}`;
		let val = 0n;
		for (; pos < end; ++pos) {
			n = buf[pos];
			val = (val << 7n) + BigInt(n & 127);
			if ((n & 128) === 0) {
				oid += `.${val}`;
				val = 0n;
			}
		}
		return oid;
	}
	function parseBoolean(buf) {
		if (buf.length !== 1) throw new error_1.ASN1ParseError("invalid boolean");
		switch (buf[0]) {
			case 0: return false;
			case 255: return true;
			default: throw new error_1.ASN1ParseError("invalid boolean");
		}
	}
	function parseBitString(buf) {
		const unused = buf[0];
		if (unused > 7) throw new error_1.ASN1ParseError("invalid bit string");
		const start = 1;
		const end = buf.length;
		const bits = [];
		for (let i = start; i < end; ++i) {
			const byte = buf[i];
			const skip = i === end - 1 ? unused : 0;
			for (let j = 7; j >= skip; --j) bits.push(byte >> j & 1);
		}
		return bits;
	}
}));
var require_tag = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ASN1Tag = void 0;
	const error_1 = require_error$2();
	const UNIVERSAL_TAG = {
		BOOLEAN: 1,
		INTEGER: 2,
		BIT_STRING: 3,
		OCTET_STRING: 4,
		OBJECT_IDENTIFIER: 6,
		SEQUENCE: 16,
		SET: 17,
		PRINTABLE_STRING: 19,
		UTC_TIME: 23,
		GENERALIZED_TIME: 24
	};
	const TAG_CLASS = {
		UNIVERSAL: 0,
		APPLICATION: 1,
		CONTEXT_SPECIFIC: 2,
		PRIVATE: 3
	};
	var ASN1Tag = class {
		number;
		constructed;
		class;
		constructor(enc) {
			this.number = enc & 31;
			this.constructed = (enc & 32) === 32;
			this.class = enc >> 6;
			if (this.number === 31) throw new error_1.ASN1ParseError("long form tags not supported");
			if (this.class === TAG_CLASS.UNIVERSAL && this.number === 0) throw new error_1.ASN1ParseError("unsupported tag 0x00");
		}
		isUniversal() {
			return this.class === TAG_CLASS.UNIVERSAL;
		}
		isContextSpecific(num) {
			const res = this.class === TAG_CLASS.CONTEXT_SPECIFIC;
			return num !== void 0 ? res && this.number === num : res;
		}
		isBoolean() {
			return this.isUniversal() && this.number === UNIVERSAL_TAG.BOOLEAN;
		}
		isInteger() {
			return this.isUniversal() && this.number === UNIVERSAL_TAG.INTEGER;
		}
		isBitString() {
			return this.isUniversal() && this.number === UNIVERSAL_TAG.BIT_STRING;
		}
		isOctetString() {
			return this.isUniversal() && this.number === UNIVERSAL_TAG.OCTET_STRING;
		}
		isOID() {
			return this.isUniversal() && this.number === UNIVERSAL_TAG.OBJECT_IDENTIFIER;
		}
		isUTCTime() {
			return this.isUniversal() && this.number === UNIVERSAL_TAG.UTC_TIME;
		}
		isGeneralizedTime() {
			return this.isUniversal() && this.number === UNIVERSAL_TAG.GENERALIZED_TIME;
		}
		toDER() {
			return this.number | (this.constructed ? 32 : 0) | this.class << 6;
		}
	};
	exports.ASN1Tag = ASN1Tag;
}));
var require_obj = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ASN1Obj = void 0;
	const stream_1 = require_stream();
	const error_1 = require_error$2();
	const length_1 = require_length();
	const parse_1 = require_parse();
	const tag_1 = require_tag();
	var ASN1Obj = class {
		tag;
		subs;
		value;
		constructor(tag, value, subs) {
			this.tag = tag;
			this.value = value;
			this.subs = subs;
		}
		static parseBuffer(buf) {
			const stream = new stream_1.ByteStream(buf);
			const obj = parseStream(stream);
			if (stream.position !== stream.length) throw new error_1.ASN1ParseError("invalid trailing data");
			return obj;
		}
		toDER() {
			const valueStream = new stream_1.ByteStream();
			if (this.subs.length > 0) for (const sub of this.subs) valueStream.appendView(sub.toDER());
			else valueStream.appendView(this.value);
			const value = valueStream.buffer;
			const obj = new stream_1.ByteStream();
			obj.appendChar(this.tag.toDER());
			obj.appendView((0, length_1.encodeLength)(value.length));
			obj.appendView(value);
			return obj.buffer;
		}
		toBoolean() {
			if (!this.tag.isBoolean()) throw new error_1.ASN1TypeError("not a boolean");
			return (0, parse_1.parseBoolean)(this.value);
		}
		toInteger() {
			if (!this.tag.isInteger()) throw new error_1.ASN1TypeError("not an integer");
			return (0, parse_1.parseInteger)(this.value);
		}
		toOID() {
			if (!this.tag.isOID()) throw new error_1.ASN1TypeError("not an OID");
			return (0, parse_1.parseOID)(this.value);
		}
		toDate() {
			switch (true) {
				case this.tag.isUTCTime(): return (0, parse_1.parseTime)(this.value, true);
				case this.tag.isGeneralizedTime(): return (0, parse_1.parseTime)(this.value, false);
				default: throw new error_1.ASN1TypeError("not a date");
			}
		}
		toBitString() {
			if (!this.tag.isBitString()) throw new error_1.ASN1TypeError("not a bit string");
			return (0, parse_1.parseBitString)(this.value);
		}
	};
	exports.ASN1Obj = ASN1Obj;
	const MAX_DEPTH = 100;
	function parseStream(stream, depth = 0) {
		if (depth > MAX_DEPTH) throw new error_1.ASN1ParseError("maximum nesting depth exceeded");
		const tag = new tag_1.ASN1Tag(stream.getUint8());
		const len = (0, length_1.decodeLength)(stream);
		const value = stream.slice(stream.position, len);
		const start = stream.position;
		let subs = [];
		if (tag.constructed) subs = collectSubs(stream, len, depth);
		else if (tag.isOctetString()) try {
			subs = collectSubs(stream, len, depth);
		} catch (e) {}
		if (subs.length === 0) stream.seek(start + len);
		return new ASN1Obj(tag, value, subs);
	}
	function collectSubs(stream, len, depth) {
		const end = stream.position + len;
		/* istanbul ignore if */
		if (end > stream.length) throw new error_1.ASN1ParseError("invalid length");
		const subs = [];
		while (stream.position < end) subs.push(parseStream(stream, depth + 1));
		if (stream.position !== end) throw new error_1.ASN1ParseError("invalid length");
		return subs;
	}
}));
var require_asn1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.ASN1Obj = void 0;
	var obj_1 = require_obj();
	Object.defineProperty(exports, "ASN1Obj", {
		enumerable: true,
		get: function() {
			return obj_1.ASN1Obj;
		}
	});
}));
var require_crypto = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __importDefault = exports && exports.__importDefault || function(mod) {
		return mod && mod.__esModule ? mod : { "default": mod };
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.createPublicKey = createPublicKey;
	exports.digest = digest;
	exports.verify = verify;
	exports.bufferEqual = bufferEqual;
	const crypto_1 = __importDefault(__require("crypto"));
	function createPublicKey(key, type = "spki") {
		if (typeof key === "string") if (key.startsWith("-----")) return crypto_1.default.createPublicKey(key);
		else return crypto_1.default.createPublicKey({
			key: Buffer.from(key, "base64"),
			format: "der",
			type
		});
		else return crypto_1.default.createPublicKey({
			key,
			format: "der",
			type
		});
	}
	function digest(algorithm, ...data) {
		const hash = crypto_1.default.createHash(algorithm);
		for (const d of data) hash.update(d);
		return hash.digest();
	}
	function algorithmForKey(key) {
		if (!(key instanceof crypto_1.default.KeyObject) || key.type !== "public") return false;
		switch (key.asymmetricKeyType) {
			case "ec": switch (key.asymmetricKeyDetails?.namedCurve) {
				case "prime256v1": return "sha256";
				case "secp384r1": return "sha384";
				case "secp521r1": return "sha512";
				default: return false;
			}
			case "ed25519": return;
			default: return false;
		}
	}
	function verify(data, key, signature, algorithm) {
		try {
			if (algorithm === void 0) {
				algorithm = algorithmForKey(key);
				if (algorithm === false) return false;
			}
			return crypto_1.default.verify(algorithm, data, key, signature);
		} catch (e) {
			/* istanbul ignore next */
			return false;
		}
	}
	function bufferEqual(a, b) {
		try {
			return crypto_1.default.timingSafeEqual(a, b);
		} catch {
			/* istanbul ignore next */
			return false;
		}
	}
}));
var require_dsse$3 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.preAuthEncoding = preAuthEncoding;
	const PAE_PREFIX = "DSSEv1";
	function preAuthEncoding(payloadType, payload) {
		const typeBytes = Buffer.from(payloadType, "utf-8");
		return Buffer.concat([
			Buffer.from(`${PAE_PREFIX} ${typeBytes.length} `, "ascii"),
			typeBytes,
			Buffer.from(` ${payload.length} `, "ascii"),
			payload
		]);
	}
}));
var require_encoding = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.base64Encode = base64Encode;
	exports.base64Decode = base64Decode;
	const BASE64_ENCODING = "base64";
	const UTF8_ENCODING = "utf-8";
	function base64Encode(str) {
		return Buffer.from(str, UTF8_ENCODING).toString(BASE64_ENCODING);
	}
	function base64Decode(str) {
		return Buffer.from(str, BASE64_ENCODING).toString(UTF8_ENCODING);
	}
}));
var require_json = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.canonicalize = canonicalize;
	function canonicalize(object) {
		let buffer = "";
		if (object === null || typeof object !== "object" || object.toJSON != null) buffer += JSON.stringify(object);
		else if (Array.isArray(object)) {
			buffer += "[";
			let first = true;
			object.forEach((element) => {
				if (!first) buffer += ",";
				first = false;
				buffer += canonicalize(element);
			});
			buffer += "]";
		} else {
			buffer += "{";
			let first = true;
			Object.keys(object).sort().forEach((property) => {
				if (!first) buffer += ",";
				first = false;
				buffer += JSON.stringify(property);
				buffer += ":";
				buffer += canonicalize(object[property]);
			});
			buffer += "}";
		}
		return buffer;
	}
}));
var require_pem = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.toDER = toDER;
	exports.fromDER = fromDER;
	const PEM_HEADER = /-----BEGIN (.*)-----/;
	const PEM_FOOTER = /-----END (.*)-----/;
	function toDER(certificate) {
		let der = "";
		certificate.split("\n").forEach((line) => {
			if (line.match(PEM_HEADER) || line.match(PEM_FOOTER)) return;
			der += line;
		});
		return Buffer.from(der, "base64");
	}
	function fromDER(certificate, type = "CERTIFICATE") {
		const lines = certificate.toString("base64").match(/.{1,64}/g) || "";
		return [
			`-----BEGIN ${type}-----`,
			...lines,
			`-----END ${type}-----`
		].join("\n").concat("\n");
	}
}));
var require_oid = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.SHA2_HASH_ALGOS = exports.RSA_SIGNATURE_ALGOS = exports.ECDSA_SIGNATURE_ALGOS = void 0;
	exports.ECDSA_SIGNATURE_ALGOS = {
		"1.2.840.10045.4.3.1": "sha224",
		"1.2.840.10045.4.3.2": "sha256",
		"1.2.840.10045.4.3.3": "sha384",
		"1.2.840.10045.4.3.4": "sha512"
	};
	exports.RSA_SIGNATURE_ALGOS = {
		"1.2.840.113549.1.1.14": "sha224",
		"1.2.840.113549.1.1.11": "sha256",
		"1.2.840.113549.1.1.12": "sha384",
		"1.2.840.113549.1.1.13": "sha512"
	};
	exports.SHA2_HASH_ALGOS = {
		"2.16.840.1.101.3.4.2.1": "sha256",
		"2.16.840.1.101.3.4.2.2": "sha384",
		"2.16.840.1.101.3.4.2.3": "sha512"
	};
}));
var require_error$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.RFC3161TimestampVerificationError = void 0;
	var RFC3161TimestampVerificationError = class extends Error {};
	exports.RFC3161TimestampVerificationError = RFC3161TimestampVerificationError;
}));
var require_tstinfo = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
		Object.defineProperty(o, "default", {
			enumerable: true,
			value: v
		});
	}) : function(o, v) {
		o["default"] = v;
	});
	var __importStar = exports && exports.__importStar || (function() {
		var ownKeys = function(o) {
			ownKeys = Object.getOwnPropertyNames || function(o) {
				var ar = [];
				for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
				return ar;
			};
			return ownKeys(o);
		};
		return function(mod) {
			if (mod && mod.__esModule) return mod;
			var result = {};
			if (mod != null) {
				for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
			}
			__setModuleDefault(result, mod);
			return result;
		};
	})();
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.TSTInfo = void 0;
	const crypto = __importStar(require_crypto());
	const oid_1 = require_oid();
	const error_1 = require_error$1();
	var TSTInfo = class {
		root;
		constructor(asn1) {
			this.root = asn1;
		}
		get version() {
			return this.root.subs[0].toInteger();
		}
		get genTime() {
			return this.root.subs[4].toDate();
		}
		get messageImprintHashAlgorithm() {
			const oid = this.messageImprintObj.subs[0].subs[0].toOID();
			return oid_1.SHA2_HASH_ALGOS[oid];
		}
		get messageImprintHashedMessage() {
			return this.messageImprintObj.subs[1].value;
		}
		get raw() {
			return this.root.toDER();
		}
		verify(data) {
			const digest = crypto.digest(this.messageImprintHashAlgorithm, data);
			if (!crypto.bufferEqual(digest, this.messageImprintHashedMessage)) throw new error_1.RFC3161TimestampVerificationError("message imprint does not match artifact");
		}
		get messageImprintObj() {
			return this.root.subs[2];
		}
	};
	exports.TSTInfo = TSTInfo;
}));
var require_timestamp$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
		Object.defineProperty(o, "default", {
			enumerable: true,
			value: v
		});
	}) : function(o, v) {
		o["default"] = v;
	});
	var __importStar = exports && exports.__importStar || (function() {
		var ownKeys = function(o) {
			ownKeys = Object.getOwnPropertyNames || function(o) {
				var ar = [];
				for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
				return ar;
			};
			return ownKeys(o);
		};
		return function(mod) {
			if (mod && mod.__esModule) return mod;
			var result = {};
			if (mod != null) {
				for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
			}
			__setModuleDefault(result, mod);
			return result;
		};
	})();
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.RFC3161Timestamp = void 0;
	const asn1_1 = require_asn1();
	const crypto = __importStar(require_crypto());
	const oid_1 = require_oid();
	const error_1 = require_error$1();
	const tstinfo_1 = require_tstinfo();
	const OID_PKCS9_CONTENT_TYPE_SIGNED_DATA = "1.2.840.113549.1.7.2";
	const OID_PKCS9_CONTENT_TYPE_TSTINFO = "1.2.840.113549.1.9.16.1.4";
	const OID_PKCS9_MESSAGE_DIGEST_KEY = "1.2.840.113549.1.9.4";
	exports.RFC3161Timestamp = class RFC3161Timestamp {
		root;
		constructor(asn1) {
			this.root = asn1;
		}
		static parse(der) {
			return new RFC3161Timestamp(asn1_1.ASN1Obj.parseBuffer(der));
		}
		get status() {
			return this.pkiStatusInfoObj.subs[0].toInteger();
		}
		get contentType() {
			return this.contentTypeObj.toOID();
		}
		get eContentType() {
			return this.eContentTypeObj.toOID();
		}
		get signingTime() {
			return this.tstInfo.genTime;
		}
		get signerIssuer() {
			return this.signerSidObj.subs[0].value;
		}
		get signerSerialNumber() {
			return this.signerSidObj.subs[1].value;
		}
		get signerDigestAlgorithm() {
			const oid = this.signerDigestAlgorithmObj.subs[0].toOID();
			return oid_1.SHA2_HASH_ALGOS[oid];
		}
		get signatureAlgorithm() {
			const oid = this.signatureAlgorithmObj.subs[0].toOID();
			return oid_1.ECDSA_SIGNATURE_ALGOS[oid];
		}
		get signatureValue() {
			return this.signatureValueObj.value;
		}
		get tstInfo() {
			return new tstinfo_1.TSTInfo(this.eContentObj.subs[0].subs[0]);
		}
		verify(data, publicKey) {
			if (!this.timeStampTokenObj) throw new error_1.RFC3161TimestampVerificationError("timeStampToken is missing");
			if (this.contentType !== OID_PKCS9_CONTENT_TYPE_SIGNED_DATA) throw new error_1.RFC3161TimestampVerificationError(`incorrect content type: ${this.contentType}`);
			if (this.eContentType !== OID_PKCS9_CONTENT_TYPE_TSTINFO) throw new error_1.RFC3161TimestampVerificationError(`incorrect encapsulated content type: ${this.eContentType}`);
			this.tstInfo.verify(data);
			this.verifyMessageDigest();
			this.verifySignature(publicKey);
		}
		verifyMessageDigest() {
			const tstInfoDigest = crypto.digest(this.signerDigestAlgorithm, this.tstInfo.raw);
			const expectedDigest = this.messageDigestAttributeObj.subs[1].subs[0].value;
			if (!crypto.bufferEqual(tstInfoDigest, expectedDigest)) throw new error_1.RFC3161TimestampVerificationError("signed data does not match tstInfo");
		}
		verifySignature(key) {
			const signedAttrs = this.signedAttrsObj.toDER();
			signedAttrs[0] = 49;
			if (!crypto.verify(signedAttrs, key, this.signatureValue, this.signatureAlgorithm)) throw new error_1.RFC3161TimestampVerificationError("signature verification failed");
		}
		get pkiStatusInfoObj() {
			return this.root.subs[0];
		}
		get timeStampTokenObj() {
			return this.root.subs[1];
		}
		get contentTypeObj() {
			return this.timeStampTokenObj.subs[0];
		}
		get signedDataObj() {
			return this.timeStampTokenObj.subs.find((sub) => sub.tag.isContextSpecific(0)).subs[0];
		}
		get encapContentInfoObj() {
			return this.signedDataObj.subs[2];
		}
		get signerInfosObj() {
			const sd = this.signedDataObj;
			return sd.subs[sd.subs.length - 1];
		}
		get signerInfoObj() {
			return this.signerInfosObj.subs[0];
		}
		get eContentTypeObj() {
			return this.encapContentInfoObj.subs[0];
		}
		get eContentObj() {
			return this.encapContentInfoObj.subs[1];
		}
		get signedAttrsObj() {
			return this.signerInfoObj.subs.find((sub) => sub.tag.isContextSpecific(0));
		}
		get messageDigestAttributeObj() {
			return this.signedAttrsObj.subs.find((sub) => sub.subs[0].tag.isOID() && sub.subs[0].toOID() === OID_PKCS9_MESSAGE_DIGEST_KEY);
		}
		get signerSidObj() {
			return this.signerInfoObj.subs[1];
		}
		get signerDigestAlgorithmObj() {
			return this.signerInfoObj.subs[2];
		}
		get signatureAlgorithmObj() {
			return this.signerInfoObj.subs[4];
		}
		get signatureValueObj() {
			return this.signerInfoObj.subs[5];
		}
	};
}));
var require_rfc3161 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.RFC3161Timestamp = void 0;
	var timestamp_1 = require_timestamp$1();
	Object.defineProperty(exports, "RFC3161Timestamp", {
		enumerable: true,
		get: function() {
			return timestamp_1.RFC3161Timestamp;
		}
	});
}));
var require_sct$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
		Object.defineProperty(o, "default", {
			enumerable: true,
			value: v
		});
	}) : function(o, v) {
		o["default"] = v;
	});
	var __importStar = exports && exports.__importStar || (function() {
		var ownKeys = function(o) {
			ownKeys = Object.getOwnPropertyNames || function(o) {
				var ar = [];
				for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
				return ar;
			};
			return ownKeys(o);
		};
		return function(mod) {
			if (mod && mod.__esModule) return mod;
			var result = {};
			if (mod != null) {
				for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
			}
			__setModuleDefault(result, mod);
			return result;
		};
	})();
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.SignedCertificateTimestamp = void 0;
	const crypto = __importStar(require_crypto());
	const stream_1 = require_stream();
	exports.SignedCertificateTimestamp = class SignedCertificateTimestamp {
		version;
		logID;
		timestamp;
		extensions;
		hashAlgorithm;
		signatureAlgorithm;
		signature;
		constructor(options) {
			this.version = options.version;
			this.logID = options.logID;
			this.timestamp = options.timestamp;
			this.extensions = options.extensions;
			this.hashAlgorithm = options.hashAlgorithm;
			this.signatureAlgorithm = options.signatureAlgorithm;
			this.signature = options.signature;
		}
		get datetime() {
			return new Date(Number(this.timestamp.readBigInt64BE()));
		}
		get algorithm() {
			switch (this.hashAlgorithm) {
				case 0: return "none";
				case 1: return "md5";
				case 2: return "sha1";
				case 3: return "sha224";
				case 4: return "sha256";
				case 5: return "sha384";
				case 6: return "sha512";
				default: return "unknown";
			}
		}
		verify(preCert, key) {
			const stream = new stream_1.ByteStream();
			stream.appendChar(this.version);
			stream.appendChar(0);
			stream.appendView(this.timestamp);
			stream.appendUint16(1);
			stream.appendView(preCert);
			stream.appendUint16(this.extensions.byteLength);
			/* istanbul ignore next - extensions are very uncommon */
			if (this.extensions.byteLength > 0) stream.appendView(this.extensions);
			return crypto.verify(stream.buffer, key, this.signature, this.algorithm);
		}
		static parse(buf) {
			const stream = new stream_1.ByteStream(buf);
			const version = stream.getUint8();
			const logID = stream.getBlock(32);
			const timestamp = stream.getBlock(8);
			const extenstionLength = stream.getUint16();
			const extensions = stream.getBlock(extenstionLength);
			const hashAlgorithm = stream.getUint8();
			const signatureAlgorithm = stream.getUint8();
			const sigLength = stream.getUint16();
			const signature = stream.getBlock(sigLength);
			if (stream.position !== buf.length) throw new Error("SCT buffer length mismatch");
			return new SignedCertificateTimestamp({
				version,
				logID,
				timestamp,
				extensions,
				hashAlgorithm,
				signatureAlgorithm,
				signature
			});
		}
	};
}));
var require_ext = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.X509SCTExtension = exports.X509SubjectKeyIDExtension = exports.X509AuthorityKeyIDExtension = exports.X509SubjectAlternativeNameExtension = exports.X509KeyUsageExtension = exports.X509BasicConstraintsExtension = exports.X509Extension = void 0;
	const stream_1 = require_stream();
	const sct_1 = require_sct$1();
	var X509Extension = class {
		root;
		constructor(asn1) {
			this.root = asn1;
		}
		get oid() {
			return this.root.subs[0].toOID();
		}
		get critical() {
			return this.root.subs.length === 3 ? this.root.subs[1].toBoolean() : false;
		}
		get value() {
			return this.extnValueObj.value;
		}
		get valueObj() {
			return this.extnValueObj;
		}
		get extnValueObj() {
			return this.root.subs[this.root.subs.length - 1];
		}
	};
	exports.X509Extension = X509Extension;
	var X509BasicConstraintsExtension = class extends X509Extension {
		get isCA() {
			return this.sequence.subs[0]?.toBoolean() ?? false;
		}
		get pathLenConstraint() {
			return this.sequence.subs.length > 1 ? this.sequence.subs[1].toInteger() : void 0;
		}
		get sequence() {
			return this.extnValueObj.subs[0];
		}
	};
	exports.X509BasicConstraintsExtension = X509BasicConstraintsExtension;
	var X509KeyUsageExtension = class extends X509Extension {
		get digitalSignature() {
			return this.bitString[0] === 1;
		}
		get keyCertSign() {
			return this.bitString[5] === 1;
		}
		get crlSign() {
			return this.bitString[6] === 1;
		}
		get bitString() {
			return this.extnValueObj.subs[0].toBitString();
		}
	};
	exports.X509KeyUsageExtension = X509KeyUsageExtension;
	var X509SubjectAlternativeNameExtension = class extends X509Extension {
		get rfc822Name() {
			return this.findGeneralName(1)?.value.toString("ascii");
		}
		get uri() {
			return this.findGeneralName(6)?.value.toString("ascii");
		}
		otherName(oid) {
			const otherName = this.findGeneralName(0);
			if (otherName === void 0) return;
			if (otherName.subs[0].toOID() !== oid) return;
			return otherName.subs[1].subs[0].value.toString("ascii");
		}
		findGeneralName(tag) {
			return this.generalNames.find((gn) => gn.tag.isContextSpecific(tag));
		}
		get generalNames() {
			return this.extnValueObj.subs[0].subs;
		}
	};
	exports.X509SubjectAlternativeNameExtension = X509SubjectAlternativeNameExtension;
	var X509AuthorityKeyIDExtension = class extends X509Extension {
		get keyIdentifier() {
			return this.findSequenceMember(0)?.value;
		}
		findSequenceMember(tag) {
			return this.sequence.subs.find((el) => el.tag.isContextSpecific(tag));
		}
		get sequence() {
			return this.extnValueObj.subs[0];
		}
	};
	exports.X509AuthorityKeyIDExtension = X509AuthorityKeyIDExtension;
	var X509SubjectKeyIDExtension = class extends X509Extension {
		get keyIdentifier() {
			return this.extnValueObj.subs[0].value;
		}
	};
	exports.X509SubjectKeyIDExtension = X509SubjectKeyIDExtension;
	var X509SCTExtension = class extends X509Extension {
		constructor(asn1) {
			super(asn1);
		}
		get signedCertificateTimestamps() {
			const buf = this.extnValueObj.subs[0].value;
			const stream = new stream_1.ByteStream(buf);
			const end = stream.getUint16() + 2;
			const sctList = [];
			while (stream.position < end) {
				const sctLength = stream.getUint16();
				const sct = stream.getBlock(sctLength);
				sctList.push(sct_1.SignedCertificateTimestamp.parse(sct));
			}
			if (stream.position !== end) throw new Error("SCT list length does not match actual length");
			return sctList;
		}
	};
	exports.X509SCTExtension = X509SCTExtension;
}));
var require_cert = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
		Object.defineProperty(o, "default", {
			enumerable: true,
			value: v
		});
	}) : function(o, v) {
		o["default"] = v;
	});
	var __importStar = exports && exports.__importStar || (function() {
		var ownKeys = function(o) {
			ownKeys = Object.getOwnPropertyNames || function(o) {
				var ar = [];
				for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
				return ar;
			};
			return ownKeys(o);
		};
		return function(mod) {
			if (mod && mod.__esModule) return mod;
			var result = {};
			if (mod != null) {
				for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
			}
			__setModuleDefault(result, mod);
			return result;
		};
	})();
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.X509Certificate = exports.EXTENSION_OID_SCT = void 0;
	const asn1_1 = require_asn1();
	const crypto = __importStar(require_crypto());
	const oid_1 = require_oid();
	const pem = __importStar(require_pem());
	const ext_1 = require_ext();
	const EXTENSION_OID_SUBJECT_KEY_ID = "2.5.29.14";
	const EXTENSION_OID_KEY_USAGE = "2.5.29.15";
	const EXTENSION_OID_SUBJECT_ALT_NAME = "2.5.29.17";
	const EXTENSION_OID_BASIC_CONSTRAINTS = "2.5.29.19";
	const EXTENSION_OID_AUTHORITY_KEY_ID = "2.5.29.35";
	exports.EXTENSION_OID_SCT = "1.3.6.1.4.1.11129.2.4.2";
	exports.X509Certificate = class X509Certificate {
		root;
		constructor(asn1) {
			this.root = asn1;
		}
		static parse(cert) {
			const der = typeof cert === "string" ? pem.toDER(cert) : cert;
			return new X509Certificate(asn1_1.ASN1Obj.parseBuffer(der));
		}
		get tbsCertificate() {
			return this.tbsCertificateObj;
		}
		get version() {
			return `v${(this.versionObj.subs[0].toInteger() + BigInt(1)).toString()}`;
		}
		get serialNumber() {
			return this.serialNumberObj.value;
		}
		get notBefore() {
			return this.validityObj.subs[0].toDate();
		}
		get notAfter() {
			return this.validityObj.subs[1].toDate();
		}
		get issuer() {
			return this.issuerObj.value;
		}
		get subject() {
			return this.subjectObj.value;
		}
		get publicKey() {
			return this.subjectPublicKeyInfoObj.toDER();
		}
		get signatureAlgorithm() {
			const oid = this.signatureAlgorithmObj.subs[0].toOID();
			if (oid_1.RSA_SIGNATURE_ALGOS[oid]) return oid_1.RSA_SIGNATURE_ALGOS[oid];
			return oid_1.ECDSA_SIGNATURE_ALGOS[oid];
		}
		get signatureValue() {
			return this.signatureValueObj.value.subarray(1);
		}
		get subjectAltName() {
			const ext = this.extSubjectAltName;
			return ext?.uri || ext?.rfc822Name;
		}
		get extensions() {
			/* istanbul ignore next */
			return (this.extensionsObj?.subs[0])?.subs || [];
		}
		get extKeyUsage() {
			const ext = this.findExtension(EXTENSION_OID_KEY_USAGE);
			return ext ? new ext_1.X509KeyUsageExtension(ext) : void 0;
		}
		get extBasicConstraints() {
			const ext = this.findExtension(EXTENSION_OID_BASIC_CONSTRAINTS);
			return ext ? new ext_1.X509BasicConstraintsExtension(ext) : void 0;
		}
		get extSubjectAltName() {
			const ext = this.findExtension(EXTENSION_OID_SUBJECT_ALT_NAME);
			return ext ? new ext_1.X509SubjectAlternativeNameExtension(ext) : void 0;
		}
		get extAuthorityKeyID() {
			const ext = this.findExtension(EXTENSION_OID_AUTHORITY_KEY_ID);
			return ext ? new ext_1.X509AuthorityKeyIDExtension(ext) : void 0;
		}
		get extSubjectKeyID() {
			const ext = this.findExtension(EXTENSION_OID_SUBJECT_KEY_ID);
			return ext ? new ext_1.X509SubjectKeyIDExtension(ext) : void 0;
		}
		get extSCT() {
			const ext = this.findExtension(exports.EXTENSION_OID_SCT);
			return ext ? new ext_1.X509SCTExtension(ext) : void 0;
		}
		get isCA() {
			const ca = this.extBasicConstraints?.isCA || false;
			/* istanbul ignore else */
			if (this.extKeyUsage) return ca && this.extKeyUsage.keyCertSign;
			/* istanbul ignore next */
			return ca;
		}
		extension(oid) {
			const ext = this.findExtension(oid);
			return ext ? new ext_1.X509Extension(ext) : void 0;
		}
		verify(issuerCertificate) {
			const publicKey = issuerCertificate?.publicKey || this.publicKey;
			const key = crypto.createPublicKey(publicKey);
			return crypto.verify(this.tbsCertificate.toDER(), key, this.signatureValue, this.signatureAlgorithm);
		}
		validForDate(date) {
			return this.notBefore <= date && date <= this.notAfter;
		}
		equals(other) {
			return this.root.toDER().equals(other.root.toDER());
		}
		clone() {
			const der = this.root.toDER();
			const clone = Buffer.alloc(der.length);
			der.copy(clone);
			return X509Certificate.parse(clone);
		}
		findExtension(oid) {
			return this.extensions.find((ext) => ext.subs[0].toOID() === oid);
		}
		get tbsCertificateObj() {
			return this.root.subs[0];
		}
		get signatureAlgorithmObj() {
			return this.root.subs[1];
		}
		get signatureValueObj() {
			return this.root.subs[2];
		}
		get versionObj() {
			return this.tbsCertificateObj.subs[0];
		}
		get serialNumberObj() {
			return this.tbsCertificateObj.subs[1];
		}
		get issuerObj() {
			return this.tbsCertificateObj.subs[3];
		}
		get validityObj() {
			return this.tbsCertificateObj.subs[4];
		}
		get subjectObj() {
			return this.tbsCertificateObj.subs[5];
		}
		get subjectPublicKeyInfoObj() {
			return this.tbsCertificateObj.subs[6];
		}
		get extensionsObj() {
			return this.tbsCertificateObj.subs.find((sub) => sub.tag.isContextSpecific(3));
		}
	};
}));
var require_x509 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.X509SCTExtension = exports.X509Certificate = exports.EXTENSION_OID_SCT = void 0;
	var cert_1 = require_cert();
	Object.defineProperty(exports, "EXTENSION_OID_SCT", {
		enumerable: true,
		get: function() {
			return cert_1.EXTENSION_OID_SCT;
		}
	});
	Object.defineProperty(exports, "X509Certificate", {
		enumerable: true,
		get: function() {
			return cert_1.X509Certificate;
		}
	});
	var ext_1 = require_ext();
	Object.defineProperty(exports, "X509SCTExtension", {
		enumerable: true,
		get: function() {
			return ext_1.X509SCTExtension;
		}
	});
}));
var require_dist$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __setModuleDefault = exports && exports.__setModuleDefault || (Object.create ? (function(o, v) {
		Object.defineProperty(o, "default", {
			enumerable: true,
			value: v
		});
	}) : function(o, v) {
		o["default"] = v;
	});
	var __importStar = exports && exports.__importStar || (function() {
		var ownKeys = function(o) {
			ownKeys = Object.getOwnPropertyNames || function(o) {
				var ar = [];
				for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
				return ar;
			};
			return ownKeys(o);
		};
		return function(mod) {
			if (mod && mod.__esModule) return mod;
			var result = {};
			if (mod != null) {
				for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
			}
			__setModuleDefault(result, mod);
			return result;
		};
	})();
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.X509SCTExtension = exports.X509Certificate = exports.EXTENSION_OID_SCT = exports.ByteStream = exports.RFC3161Timestamp = exports.pem = exports.json = exports.encoding = exports.dsse = exports.crypto = exports.ASN1Obj = void 0;
	var asn1_1 = require_asn1();
	Object.defineProperty(exports, "ASN1Obj", {
		enumerable: true,
		get: function() {
			return asn1_1.ASN1Obj;
		}
	});
	exports.crypto = __importStar(require_crypto());
	exports.dsse = __importStar(require_dsse$3());
	exports.encoding = __importStar(require_encoding());
	exports.json = __importStar(require_json());
	exports.pem = __importStar(require_pem());
	var rfc3161_1 = require_rfc3161();
	Object.defineProperty(exports, "RFC3161Timestamp", {
		enumerable: true,
		get: function() {
			return rfc3161_1.RFC3161Timestamp;
		}
	});
	var stream_1 = require_stream();
	Object.defineProperty(exports, "ByteStream", {
		enumerable: true,
		get: function() {
			return stream_1.ByteStream;
		}
	});
	var x509_1 = require_x509();
	Object.defineProperty(exports, "EXTENSION_OID_SCT", {
		enumerable: true,
		get: function() {
			return x509_1.EXTENSION_OID_SCT;
		}
	});
	Object.defineProperty(exports, "X509Certificate", {
		enumerable: true,
		get: function() {
			return x509_1.X509Certificate;
		}
	});
	Object.defineProperty(exports, "X509SCTExtension", {
		enumerable: true,
		get: function() {
			return x509_1.X509SCTExtension;
		}
	});
}));
var require_dsse$2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.DSSESignatureContent = void 0;
	const core_1 = require_dist$1();
	var DSSESignatureContent = class {
		env;
		constructor(env) {
			this.env = env;
		}
		compareDigest(digest) {
			return core_1.crypto.bufferEqual(digest, core_1.crypto.digest("sha256", this.env.payload));
		}
		compareSignedDigest(digest) {
			return core_1.crypto.bufferEqual(digest, core_1.crypto.digest("sha256", this.preAuthEncoding));
		}
		compareSignature(signature) {
			return core_1.crypto.bufferEqual(signature, this.signature);
		}
		verifySignature(key) {
			return core_1.crypto.verify(this.preAuthEncoding, key, this.signature);
		}
		get signature() {
			return this.env.signatures.length > 0 ? this.env.signatures[0].sig : Buffer.from("");
		}
		get preAuthEncoding() {
			return core_1.dsse.preAuthEncoding(this.env.payloadType, this.env.payload);
		}
	};
	exports.DSSESignatureContent = DSSESignatureContent;
}));
var require_message = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.MessageSignatureContent = void 0;
	const core_1 = require_dist$1();
	const protobuf_specs_1 = require_dist$3();
	const HASH_ALGORITHM_MAP = {
		[protobuf_specs_1.HashAlgorithm.HASH_ALGORITHM_UNSPECIFIED]: "sha256",
		[protobuf_specs_1.HashAlgorithm.SHA2_256]: "sha256",
		[protobuf_specs_1.HashAlgorithm.SHA2_384]: "sha384",
		[protobuf_specs_1.HashAlgorithm.SHA2_512]: "sha512",
		[protobuf_specs_1.HashAlgorithm.SHA3_256]: "sha3-256",
		[protobuf_specs_1.HashAlgorithm.SHA3_384]: "sha3-384"
	};
	var MessageSignatureContent = class {
		signature;
		messageDigest;
		artifact;
		hashAlgorithm;
		constructor(messageSignature, artifact) {
			this.signature = messageSignature.signature;
			this.messageDigest = messageSignature.messageDigest.digest;
			this.artifact = artifact;
			this.hashAlgorithm = HASH_ALGORITHM_MAP[messageSignature.messageDigest.algorithm] ?? "sha256";
		}
		compareSignature(signature) {
			return core_1.crypto.bufferEqual(signature, this.signature);
		}
		compareDigest(digest) {
			return core_1.crypto.bufferEqual(digest, this.messageDigest);
		}
		compareSignedDigest(digest) {
			return this.compareDigest(digest);
		}
		verifySignature(key) {
			return core_1.crypto.verify(this.artifact, key, this.signature, this.hashAlgorithm);
		}
	};
	exports.MessageSignatureContent = MessageSignatureContent;
}));
var require_bundle = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.toSignedEntity = toSignedEntity;
	exports.signatureContent = signatureContent;
	const core_1 = require_dist$1();
	const dsse_1 = require_dsse$2();
	const message_1 = require_message();
	function toSignedEntity(bundle, artifact) {
		const { tlogEntries, timestampVerificationData } = bundle.verificationMaterial;
		const timestamps = [];
		for (const entry of tlogEntries) if (entry.integratedTime && entry.integratedTime !== "0") timestamps.push({
			$case: "transparency-log",
			tlogEntry: entry
		});
		for (const ts of timestampVerificationData?.rfc3161Timestamps ?? []) timestamps.push({
			$case: "timestamp-authority",
			timestamp: core_1.RFC3161Timestamp.parse(Buffer.from(ts.signedTimestamp))
		});
		return {
			signature: signatureContent(bundle, artifact),
			key: key(bundle),
			tlogEntries,
			timestamps
		};
	}
	function signatureContent(bundle, artifact) {
		switch (bundle.content.$case) {
			case "dsseEnvelope": return new dsse_1.DSSESignatureContent(bundle.content.dsseEnvelope);
			case "messageSignature": return new message_1.MessageSignatureContent(bundle.content.messageSignature, artifact);
		}
	}
	function key(bundle) {
		switch (bundle.verificationMaterial.content.$case) {
			case "publicKey": return {
				$case: "public-key",
				hint: bundle.verificationMaterial.content.publicKey.hint
			};
			case "x509CertificateChain": return {
				$case: "certificate",
				certificate: core_1.X509Certificate.parse(Buffer.from(bundle.verificationMaterial.content.x509CertificateChain.certificates[0].rawBytes))
			};
			case "certificate": return {
				$case: "certificate",
				certificate: core_1.X509Certificate.parse(Buffer.from(bundle.verificationMaterial.content.certificate.rawBytes))
			};
		}
	}
}));
var require_error = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.PolicyError = exports.VerificationError = void 0;
	var BaseError = class extends Error {
		code;
		cause;
		constructor({ code, message, cause }) {
			super(message);
			this.code = code;
			this.cause = cause;
			this.name = this.constructor.name;
		}
	};
	var VerificationError = class extends BaseError {};
	exports.VerificationError = VerificationError;
	var PolicyError = class extends BaseError {};
	exports.PolicyError = PolicyError;
}));
var require_filter = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.filterCertAuthorities = filterCertAuthorities;
	exports.filterTLogAuthorities = filterTLogAuthorities;
	function filterCertAuthorities(certAuthorities, timestamp) {
		return certAuthorities.filter((ca) => {
			return ca.validFor.start <= timestamp && ca.validFor.end >= timestamp;
		});
	}
	function filterTLogAuthorities(tlogAuthorities, criteria) {
		return tlogAuthorities.filter((tlog) => {
			if (criteria.logID && !tlog.logID.equals(criteria.logID)) return false;
			return tlog.validFor.start <= criteria.targetDate && criteria.targetDate <= tlog.validFor.end;
		});
	}
}));
var require_trust = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.filterTLogAuthorities = exports.filterCertAuthorities = void 0;
	exports.toTrustMaterial = toTrustMaterial;
	const core_1 = require_dist$1();
	const protobuf_specs_1 = require_dist$3();
	const error_1 = require_error();
	const BEGINNING_OF_TIME = /* @__PURE__ */ new Date(0);
	const END_OF_TIME = /* @__PURE__ */ new Date(864e13);
	var filter_1 = require_filter();
	Object.defineProperty(exports, "filterCertAuthorities", {
		enumerable: true,
		get: function() {
			return filter_1.filterCertAuthorities;
		}
	});
	Object.defineProperty(exports, "filterTLogAuthorities", {
		enumerable: true,
		get: function() {
			return filter_1.filterTLogAuthorities;
		}
	});
	function toTrustMaterial(root, keys) {
		const keyFinder = typeof keys === "function" ? keys : keyLocator(keys);
		return {
			certificateAuthorities: root.certificateAuthorities.map(createCertAuthority),
			timestampAuthorities: root.timestampAuthorities.map(createCertAuthority),
			tlogs: root.tlogs.map(createTLogAuthority),
			ctlogs: root.ctlogs.map(createTLogAuthority),
			publicKey: keyFinder
		};
	}
	function createTLogAuthority(tlogInstance) {
		const keyDetails = tlogInstance.publicKey.keyDetails;
		const keyType = keyDetails === protobuf_specs_1.PublicKeyDetails.PKCS1_RSA_PKCS1V5 || keyDetails === protobuf_specs_1.PublicKeyDetails.PKIX_RSA_PKCS1V5 || keyDetails === protobuf_specs_1.PublicKeyDetails.PKIX_RSA_PKCS1V15_2048_SHA256 || keyDetails === protobuf_specs_1.PublicKeyDetails.PKIX_RSA_PKCS1V15_3072_SHA256 || keyDetails === protobuf_specs_1.PublicKeyDetails.PKIX_RSA_PKCS1V15_4096_SHA256 ? "pkcs1" : "spki";
		/* istanbul ignore next */
		return {
			baseURL: tlogInstance.baseUrl,
			logID: tlogInstance.checkpointKeyId ? tlogInstance.checkpointKeyId.keyId : tlogInstance.logId.keyId,
			publicKey: core_1.crypto.createPublicKey(tlogInstance.publicKey.rawBytes, keyType),
			validFor: {
				start: tlogInstance.publicKey.validFor?.start || BEGINNING_OF_TIME,
				end: tlogInstance.publicKey.validFor?.end || END_OF_TIME
			}
		};
	}
	function createCertAuthority(ca) {
		/* istanbul ignore next */
		return {
			certChain: ca.certChain.certificates.map((cert) => {
				return core_1.X509Certificate.parse(Buffer.from(cert.rawBytes));
			}),
			validFor: {
				start: ca.validFor?.start || BEGINNING_OF_TIME,
				end: ca.validFor?.end || END_OF_TIME
			}
		};
	}
	function keyLocator(keys) {
		return (hint) => {
			const key = (keys || {})[hint];
			if (!key) throw new error_1.VerificationError({
				code: "PUBLIC_KEY_ERROR",
				message: `key not found: ${hint}`
			});
			return {
				publicKey: core_1.crypto.createPublicKey(key.rawBytes),
				validFor: (date) => {
					/* istanbul ignore next */
					return (key.validFor?.start || BEGINNING_OF_TIME) <= date && (key.validFor?.end || END_OF_TIME) >= date;
				}
			};
		};
	}
}));
var require_certificate = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CertificateChainVerifier = void 0;
	exports.verifyCertificateChain = verifyCertificateChain;
	const error_1 = require_error();
	const trust_1 = require_trust();
	function verifyCertificateChain(timestamp, leaf, certificateAuthorities) {
		const cas = (0, trust_1.filterCertAuthorities)(certificateAuthorities, timestamp);
		let error;
		for (const ca of cas) try {
			return new CertificateChainVerifier({
				trustedCerts: ca.certChain,
				untrustedCert: leaf,
				timestamp
			}).verify();
		} catch (err) {
			error = err;
		}
		throw new error_1.VerificationError({
			code: "CERTIFICATE_ERROR",
			message: "Failed to verify certificate chain",
			cause: error
		});
	}
	var CertificateChainVerifier = class {
		untrustedCert;
		trustedCerts;
		localCerts;
		timestamp;
		constructor(opts) {
			this.untrustedCert = opts.untrustedCert;
			this.trustedCerts = opts.trustedCerts;
			this.localCerts = dedupeCertificates([...opts.trustedCerts, opts.untrustedCert]);
			this.timestamp = opts.timestamp;
		}
		verify() {
			const certificatePath = this.sort();
			this.checkPath(certificatePath);
			if (!certificatePath.every((cert) => cert.validForDate(this.timestamp))) throw new error_1.VerificationError({
				code: "CERTIFICATE_ERROR",
				message: "certificate is not valid or expired at the specified date"
			});
			return certificatePath;
		}
		sort() {
			const leafCert = this.untrustedCert;
			let paths = this.buildPaths(leafCert);
			paths = paths.filter((path) => path.some((cert) => this.trustedCerts.includes(cert)));
			if (paths.length === 0) throw new error_1.VerificationError({
				code: "CERTIFICATE_ERROR",
				message: "no trusted certificate path found"
			});
			return [leafCert, ...paths.reduce((prev, curr) => prev.length < curr.length ? prev : curr)].slice(0, -1);
		}
		buildPaths(certificate) {
			const paths = [];
			const issuers = this.findIssuer(certificate);
			if (issuers.length === 0) throw new error_1.VerificationError({
				code: "CERTIFICATE_ERROR",
				message: "no valid certificate path found"
			});
			for (let i = 0; i < issuers.length; i++) {
				const issuer = issuers[i];
				if (issuer.equals(certificate)) {
					paths.push([certificate]);
					continue;
				}
				const subPaths = this.buildPaths(issuer);
				for (let j = 0; j < subPaths.length; j++) paths.push([issuer, ...subPaths[j]]);
			}
			return paths;
		}
		findIssuer(certificate) {
			let issuers = [];
			let keyIdentifier;
			if (certificate.subject.equals(certificate.issuer)) {
				if (certificate.verify()) return [certificate];
			}
			if (certificate.extAuthorityKeyID) keyIdentifier = certificate.extAuthorityKeyID.keyIdentifier;
			this.localCerts.forEach((possibleIssuer) => {
				if (keyIdentifier) {
					/* istanbul ignore else */
					if (possibleIssuer.extSubjectKeyID) {
						if (possibleIssuer.extSubjectKeyID.keyIdentifier.equals(keyIdentifier)) issuers.push(possibleIssuer);
						return;
					}
				}
				if (possibleIssuer.subject.equals(certificate.issuer)) issuers.push(possibleIssuer);
			});
			issuers = issuers.filter((issuer) => {
				try {
					return certificate.verify(issuer);
				} catch (ex) {
					/* istanbul ignore next - should never error */
					return false;
				}
			});
			return issuers;
		}
		checkPath(path) {
			/* istanbul ignore if */
			if (path.length < 1) throw new error_1.VerificationError({
				code: "CERTIFICATE_ERROR",
				message: "certificate chain must contain at least one certificate"
			});
			if (!path.slice(1).every((cert) => cert.isCA)) throw new error_1.VerificationError({
				code: "CERTIFICATE_ERROR",
				message: "intermediate certificate is not a CA"
			});
			for (let i = path.length - 2; i >= 0; i--)
 /* istanbul ignore if */
			if (!path[i].issuer.equals(path[i + 1].subject)) throw new error_1.VerificationError({
				code: "CERTIFICATE_ERROR",
				message: "incorrect certificate name chaining"
			});
			for (let i = 0; i < path.length; i++) {
				const cert = path[i];
				if (cert.extBasicConstraints?.isCA) {
					const pathLength = cert.extBasicConstraints.pathLenConstraint;
					if (pathLength !== void 0 && pathLength < i - 1) throw new error_1.VerificationError({
						code: "CERTIFICATE_ERROR",
						message: "path length constraint exceeded"
					});
				}
			}
		}
	};
	exports.CertificateChainVerifier = CertificateChainVerifier;
	function dedupeCertificates(certs) {
		for (let i = 0; i < certs.length; i++) for (let j = i + 1; j < certs.length; j++) if (certs[i].equals(certs[j])) {
			certs.splice(j, 1);
			j--;
		}
		return certs;
	}
}));
var require_sct = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.verifySCTs = verifySCTs;
	const core_1 = require_dist$1();
	const error_1 = require_error();
	const trust_1 = require_trust();
	function verifySCTs(cert, issuer, ctlogs) {
		let extSCT;
		const clone = cert.clone();
		for (let i = 0; i < clone.extensions.length; i++) {
			const ext = clone.extensions[i];
			if (ext.subs[0].toOID() === core_1.EXTENSION_OID_SCT) {
				extSCT = new core_1.X509SCTExtension(ext);
				clone.extensions.splice(i, 1);
				break;
			}
		}
		if (!extSCT) return [];
		/* istanbul ignore if -- too difficult to fabricate test case for this */
		if (extSCT.signedCertificateTimestamps.length === 0) return [];
		const preCert = new core_1.ByteStream();
		const issuerId = core_1.crypto.digest("sha256", issuer.publicKey);
		preCert.appendView(issuerId);
		const tbs = clone.tbsCertificate.toDER();
		preCert.appendUint24(tbs.length);
		preCert.appendView(tbs);
		return extSCT.signedCertificateTimestamps.map((sct) => {
			if (!(0, trust_1.filterTLogAuthorities)(ctlogs, {
				logID: sct.logID,
				targetDate: sct.datetime
			}).some((log) => sct.verify(preCert.buffer, log.publicKey))) throw new error_1.VerificationError({
				code: "CERTIFICATE_ERROR",
				message: "SCT verification failed"
			});
			return sct.logID;
		});
	}
}));
var require_key = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.verifyPublicKey = verifyPublicKey;
	exports.verifyCertificate = verifyCertificate;
	const core_1 = require_dist$1();
	const error_1 = require_error();
	const certificate_1 = require_certificate();
	const sct_1 = require_sct();
	const OID_FULCIO_ISSUER_V1 = "1.3.6.1.4.1.57264.1.1";
	const OID_FULCIO_ISSUER_V2 = "1.3.6.1.4.1.57264.1.8";
	function verifyPublicKey(hint, timestamps, trustMaterial) {
		const key = trustMaterial.publicKey(hint);
		timestamps.forEach((timestamp) => {
			if (!key.validFor(timestamp)) throw new error_1.VerificationError({
				code: "PUBLIC_KEY_ERROR",
				message: `Public key is not valid for timestamp: ${timestamp.toISOString()}`
			});
		});
		return { key: key.publicKey };
	}
	function verifyCertificate(leaf, timestamps, trustMaterial) {
		let path = [];
		timestamps.forEach((timestamp) => {
			path = (0, certificate_1.verifyCertificateChain)(timestamp, leaf, trustMaterial.certificateAuthorities);
		});
		return {
			scts: (0, sct_1.verifySCTs)(path[0], path[1], trustMaterial.ctlogs),
			signer: getSigner(path[0])
		};
	}
	function getSigner(cert) {
		let issuer;
		const issuerExtension = cert.extension(OID_FULCIO_ISSUER_V2);
		/* istanbul ignore next */
		if (issuerExtension) issuer = issuerExtension.valueObj.subs?.[0]?.value.toString("ascii");
		else issuer = cert.extension(OID_FULCIO_ISSUER_V1)?.value.toString("ascii");
		const oids = cert.extensions.map((ext) => {
			return {
				oid: { id: ext.subs[0].toOID().split(".").map(Number) },
				value: ext.subs[ext.subs.length - 1].value
			};
		});
		const identity = {
			extensions: { issuer },
			subjectAlternativeName: cert.subjectAltName,
			oids
		};
		return {
			key: core_1.crypto.createPublicKey(cert.publicKey),
			identity
		};
	}
}));
var require_policy = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.verifySubjectAlternativeName = verifySubjectAlternativeName;
	exports.verifyExtensions = verifyExtensions;
	exports.verifyOIDs = verifyOIDs;
	const error_1 = require_error();
	function verifySubjectAlternativeName(policyIdentity, signerIdentity) {
		if (signerIdentity === void 0 || !signerIdentity.match(policyIdentity)) throw new error_1.PolicyError({
			code: "UNTRUSTED_SIGNER_ERROR",
			message: `certificate identity error - expected ${policyIdentity}, got ${signerIdentity}`
		});
	}
	function verifyExtensions(policyExtensions, signerExtensions = {}) {
		let key;
		for (key in policyExtensions) if (signerExtensions[key] !== policyExtensions[key]) throw new error_1.PolicyError({
			code: "UNTRUSTED_SIGNER_ERROR",
			message: `invalid certificate extension - expected ${key}=${policyExtensions[key]}, got ${key}=${signerExtensions[key]}`
		});
	}
	function verifyOIDs(policyOIDs, signerOIDs = []) {
		for (const policyOID of policyOIDs) if (!signerOIDs.find((signerOID) => oidEquals(policyOID.oid?.id, signerOID.oid?.id) && policyOID.value.equals(signerOID.value))) {
			const oid = policyOID.oid?.id.join(".") ?? "<unknown>";
			throw new error_1.PolicyError({
				code: "UNTRUSTED_SIGNER_ERROR",
				message: `invalid certificate extension - missing OID ${oid}`
			});
		}
	}
	function oidEquals(a, b) {
		if (a === void 0 || b === void 0) return false;
		return a.length === b.length && a.every((v, i) => v === b[i]);
	}
}));
var require_tsa = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.verifyRFC3161Timestamp = verifyRFC3161Timestamp;
	const core_1 = require_dist$1();
	const error_1 = require_error();
	const certificate_1 = require_certificate();
	const trust_1 = require_trust();
	function verifyRFC3161Timestamp(timestamp, data, timestampAuthorities) {
		const signingTime = timestamp.signingTime;
		timestampAuthorities = (0, trust_1.filterCertAuthorities)(timestampAuthorities, signingTime);
		timestampAuthorities = filterCAsBySerialAndIssuer(timestampAuthorities, {
			serialNumber: timestamp.signerSerialNumber,
			issuer: timestamp.signerIssuer
		});
		if (!timestampAuthorities.some((ca) => {
			try {
				verifyTimestampForCA(timestamp, data, ca);
				return true;
			} catch (e) {
				return false;
			}
		})) throw new error_1.VerificationError({
			code: "TIMESTAMP_ERROR",
			message: "timestamp could not be verified"
		});
	}
	function verifyTimestampForCA(timestamp, data, ca) {
		const [leaf, ...cas] = ca.certChain;
		const signingKey = core_1.crypto.createPublicKey(leaf.publicKey);
		const signingTime = timestamp.signingTime;
		try {
			new certificate_1.CertificateChainVerifier({
				untrustedCert: leaf,
				trustedCerts: cas,
				timestamp: signingTime
			}).verify();
		} catch (e) {
			throw new error_1.VerificationError({
				code: "TIMESTAMP_ERROR",
				message: "invalid certificate chain"
			});
		}
		timestamp.verify(data, signingKey);
	}
	function filterCAsBySerialAndIssuer(timestampAuthorities, criteria) {
		return timestampAuthorities.filter((ca) => ca.certChain.length > 0 && core_1.crypto.bufferEqual(ca.certChain[0].serialNumber, criteria.serialNumber) && core_1.crypto.bufferEqual(ca.certChain[0].issuer, criteria.issuer));
	}
}));
var require_timestamp = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.getTSATimestamp = getTSATimestamp;
	exports.getTLogTimestamp = getTLogTimestamp;
	const tsa_1 = require_tsa();
	function getTSATimestamp(timestamp, data, timestampAuthorities) {
		(0, tsa_1.verifyRFC3161Timestamp)(timestamp, data, timestampAuthorities);
		return {
			type: "timestamp-authority",
			logID: timestamp.signerSerialNumber,
			timestamp: timestamp.signingTime
		};
	}
	function getTLogTimestamp(entry) {
		if (!entry.inclusionPromise) return;
		return {
			type: "transparency-log",
			logID: entry.logId.keyId,
			timestamp: /* @__PURE__ */ new Date(Number(entry.integratedTime) * 1e3)
		};
	}
}));
var require_verifier$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Signature = exports.Verifier = exports.PublicKey = void 0;
	const sigstore_common_1 = require_sigstore_common();
	exports.PublicKey = {
		fromJSON(object) {
			return { rawBytes: isSet(object.rawBytes) ? Buffer.from(bytesFromBase64(object.rawBytes)) : Buffer.alloc(0) };
		},
		toJSON(message) {
			const obj = {};
			if (message.rawBytes.length !== 0) obj.rawBytes = base64FromBytes(message.rawBytes);
			return obj;
		}
	};
	exports.Verifier = {
		fromJSON(object) {
			return {
				verifier: isSet(object.publicKey) ? {
					$case: "publicKey",
					publicKey: exports.PublicKey.fromJSON(object.publicKey)
				} : isSet(object.x509Certificate) ? {
					$case: "x509Certificate",
					x509Certificate: sigstore_common_1.X509Certificate.fromJSON(object.x509Certificate)
				} : void 0,
				keyDetails: isSet(object.keyDetails) ? (0, sigstore_common_1.publicKeyDetailsFromJSON)(object.keyDetails) : 0
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.verifier?.$case === "publicKey") obj.publicKey = exports.PublicKey.toJSON(message.verifier.publicKey);
			else if (message.verifier?.$case === "x509Certificate") obj.x509Certificate = sigstore_common_1.X509Certificate.toJSON(message.verifier.x509Certificate);
			if (message.keyDetails !== 0) obj.keyDetails = (0, sigstore_common_1.publicKeyDetailsToJSON)(message.keyDetails);
			return obj;
		}
	};
	exports.Signature = {
		fromJSON(object) {
			return {
				content: isSet(object.content) ? Buffer.from(bytesFromBase64(object.content)) : Buffer.alloc(0),
				verifier: isSet(object.verifier) ? exports.Verifier.fromJSON(object.verifier) : void 0
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.content.length !== 0) obj.content = base64FromBytes(message.content);
			if (message.verifier !== void 0) obj.verifier = exports.Verifier.toJSON(message.verifier);
			return obj;
		}
	};
	function bytesFromBase64(b64) {
		return Uint8Array.from(globalThis.Buffer.from(b64, "base64"));
	}
	function base64FromBytes(arr) {
		return globalThis.Buffer.from(arr).toString("base64");
	}
	function isSet(value) {
		return value !== null && value !== void 0;
	}
}));
var require_dsse$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.DSSELogEntryV002 = exports.DSSERequestV002 = void 0;
	const envelope_1 = require_envelope();
	const sigstore_common_1 = require_sigstore_common();
	const verifier_1 = require_verifier$1();
	exports.DSSERequestV002 = {
		fromJSON(object) {
			return {
				envelope: isSet(object.envelope) ? envelope_1.Envelope.fromJSON(object.envelope) : void 0,
				verifiers: globalThis.Array.isArray(object?.verifiers) ? object.verifiers.map((e) => verifier_1.Verifier.fromJSON(e)) : []
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.envelope !== void 0) obj.envelope = envelope_1.Envelope.toJSON(message.envelope);
			if (message.verifiers?.length) obj.verifiers = message.verifiers.map((e) => verifier_1.Verifier.toJSON(e));
			return obj;
		}
	};
	exports.DSSELogEntryV002 = {
		fromJSON(object) {
			return {
				payloadHash: isSet(object.payloadHash) ? sigstore_common_1.HashOutput.fromJSON(object.payloadHash) : void 0,
				signatures: globalThis.Array.isArray(object?.signatures) ? object.signatures.map((e) => verifier_1.Signature.fromJSON(e)) : []
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.payloadHash !== void 0) obj.payloadHash = sigstore_common_1.HashOutput.toJSON(message.payloadHash);
			if (message.signatures?.length) obj.signatures = message.signatures.map((e) => verifier_1.Signature.toJSON(e));
			return obj;
		}
	};
	function isSet(value) {
		return value !== null && value !== void 0;
	}
}));
var require_hashedrekord$1 = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.HashedRekordLogEntryV002 = exports.HashedRekordRequestV002 = void 0;
	const sigstore_common_1 = require_sigstore_common();
	const verifier_1 = require_verifier$1();
	exports.HashedRekordRequestV002 = {
		fromJSON(object) {
			return {
				digest: isSet(object.digest) ? Buffer.from(bytesFromBase64(object.digest)) : Buffer.alloc(0),
				signature: isSet(object.signature) ? verifier_1.Signature.fromJSON(object.signature) : void 0
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.digest.length !== 0) obj.digest = base64FromBytes(message.digest);
			if (message.signature !== void 0) obj.signature = verifier_1.Signature.toJSON(message.signature);
			return obj;
		}
	};
	exports.HashedRekordLogEntryV002 = {
		fromJSON(object) {
			return {
				data: isSet(object.data) ? sigstore_common_1.HashOutput.fromJSON(object.data) : void 0,
				signature: isSet(object.signature) ? verifier_1.Signature.fromJSON(object.signature) : void 0
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.data !== void 0) obj.data = sigstore_common_1.HashOutput.toJSON(message.data);
			if (message.signature !== void 0) obj.signature = verifier_1.Signature.toJSON(message.signature);
			return obj;
		}
	};
	function bytesFromBase64(b64) {
		return Uint8Array.from(globalThis.Buffer.from(b64, "base64"));
	}
	function base64FromBytes(arr) {
		return globalThis.Buffer.from(arr).toString("base64");
	}
	function isSet(value) {
		return value !== null && value !== void 0;
	}
}));
var require_entry = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.CreateEntryRequest = exports.Spec = exports.Entry = void 0;
	const dsse_1 = require_dsse$1();
	const hashedrekord_1 = require_hashedrekord$1();
	exports.Entry = {
		fromJSON(object) {
			return {
				kind: isSet(object.kind) ? globalThis.String(object.kind) : "",
				apiVersion: isSet(object.apiVersion) ? globalThis.String(object.apiVersion) : "",
				spec: isSet(object.spec) ? exports.Spec.fromJSON(object.spec) : void 0
			};
		},
		toJSON(message) {
			const obj = {};
			if (message.kind !== "") obj.kind = message.kind;
			if (message.apiVersion !== "") obj.apiVersion = message.apiVersion;
			if (message.spec !== void 0) obj.spec = exports.Spec.toJSON(message.spec);
			return obj;
		}
	};
	exports.Spec = {
		fromJSON(object) {
			return { spec: isSet(object.hashedRekordV002) ? {
				$case: "hashedRekordV002",
				hashedRekordV002: hashedrekord_1.HashedRekordLogEntryV002.fromJSON(object.hashedRekordV002)
			} : isSet(object.dsseV002) ? {
				$case: "dsseV002",
				dsseV002: dsse_1.DSSELogEntryV002.fromJSON(object.dsseV002)
			} : void 0 };
		},
		toJSON(message) {
			const obj = {};
			if (message.spec?.$case === "hashedRekordV002") obj.hashedRekordV002 = hashedrekord_1.HashedRekordLogEntryV002.toJSON(message.spec.hashedRekordV002);
			else if (message.spec?.$case === "dsseV002") obj.dsseV002 = dsse_1.DSSELogEntryV002.toJSON(message.spec.dsseV002);
			return obj;
		}
	};
	exports.CreateEntryRequest = {
		fromJSON(object) {
			return { spec: isSet(object.hashedRekordRequestV002) ? {
				$case: "hashedRekordRequestV002",
				hashedRekordRequestV002: hashedrekord_1.HashedRekordRequestV002.fromJSON(object.hashedRekordRequestV002)
			} : isSet(object.dsseRequestV002) ? {
				$case: "dsseRequestV002",
				dsseRequestV002: dsse_1.DSSERequestV002.fromJSON(object.dsseRequestV002)
			} : void 0 };
		},
		toJSON(message) {
			const obj = {};
			if (message.spec?.$case === "hashedRekordRequestV002") obj.hashedRekordRequestV002 = hashedrekord_1.HashedRekordRequestV002.toJSON(message.spec.hashedRekordRequestV002);
			else if (message.spec?.$case === "dsseRequestV002") obj.dsseRequestV002 = dsse_1.DSSERequestV002.toJSON(message.spec.dsseRequestV002);
			return obj;
		}
	};
	function isSet(value) {
		return value !== null && value !== void 0;
	}
}));
var require_v2 = /* @__PURE__ */ __commonJSMin(((exports) => {
	var __createBinding = exports && exports.__createBinding || (Object.create ? (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		var desc = Object.getOwnPropertyDescriptor(m, k);
		if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) desc = {
			enumerable: true,
			get: function() {
				return m[k];
			}
		};
		Object.defineProperty(o, k2, desc);
	}) : (function(o, m, k, k2) {
		if (k2 === void 0) k2 = k;
		o[k2] = m[k];
	}));
	var __exportStar = exports && exports.__exportStar || function(m, exports$1) {
		for (var p in m) if (p !== "default" && !Object.prototype.hasOwnProperty.call(exports$1, p)) __createBinding(exports$1, m, p);
	};
	Object.defineProperty(exports, "__esModule", { value: true });
	__exportStar(require_dsse$1(), exports);
	__exportStar(require_entry(), exports);
	__exportStar(require_hashedrekord$1(), exports);
	__exportStar(require_verifier$1(), exports);
}));
var require_dsse = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.DSSE_API_VERSION_V1 = void 0;
	exports.verifyDSSETLogBody = verifyDSSETLogBody;
	exports.verifyDSSETLogBodyV2 = verifyDSSETLogBodyV2;
	const error_1 = require_error();
	exports.DSSE_API_VERSION_V1 = "0.0.1";
	function verifyDSSETLogBody(tlogEntry, content) {
		switch (tlogEntry.apiVersion) {
			case exports.DSSE_API_VERSION_V1: return verifyDSSE001TLogBody(tlogEntry, content);
			default: throw new error_1.VerificationError({
				code: "TLOG_BODY_ERROR",
				message: `unsupported dsse version: ${tlogEntry.apiVersion}`
			});
		}
	}
	function verifyDSSETLogBodyV2(tlogEntry, content) {
		const spec = tlogEntry.spec?.spec;
		if (!spec) throw new error_1.VerificationError({
			code: "TLOG_BODY_ERROR",
			message: `missing dsse spec`
		});
		switch (spec.$case) {
			case "dsseV002": return verifyDSSE002TLogBody(spec.dsseV002, content);
			default: throw new error_1.VerificationError({
				code: "TLOG_BODY_ERROR",
				message: `unsupported version: ${spec.$case}`
			});
		}
	}
	function verifyDSSE001TLogBody(tlogEntry, content) {
		if (tlogEntry.spec.signatures?.length !== 1) throw new error_1.VerificationError({
			code: "TLOG_BODY_ERROR",
			message: "signature count mismatch"
		});
		const tlogSig = tlogEntry.spec.signatures[0].signature;
		if (!content.compareSignature(Buffer.from(tlogSig, "base64"))) throw new error_1.VerificationError({
			code: "TLOG_BODY_ERROR",
			message: "tlog entry signature mismatch"
		});
		const tlogHash = tlogEntry.spec.payloadHash?.value || "";
		if (!content.compareDigest(Buffer.from(tlogHash, "hex"))) throw new error_1.VerificationError({
			code: "TLOG_BODY_ERROR",
			message: "DSSE payload hash mismatch"
		});
	}
	function verifyDSSE002TLogBody(spec, content) {
		if (spec.signatures?.length !== 1) throw new error_1.VerificationError({
			code: "TLOG_BODY_ERROR",
			message: "signature count mismatch"
		});
		const tlogSig = spec.signatures[0].content;
		if (!content.compareSignature(tlogSig)) throw new error_1.VerificationError({
			code: "TLOG_BODY_ERROR",
			message: "tlog entry signature mismatch"
		});
		const tlogHash = spec.payloadHash?.digest || Buffer.from("");
		if (!content.compareDigest(tlogHash)) throw new error_1.VerificationError({
			code: "TLOG_BODY_ERROR",
			message: "DSSE payload hash mismatch"
		});
	}
}));
var require_hashedrekord = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.HASHEDREKORD_API_VERSION_V1 = void 0;
	exports.verifyHashedRekordTLogBody = verifyHashedRekordTLogBody;
	exports.verifyHashedRekordTLogBodyV2 = verifyHashedRekordTLogBodyV2;
	const error_1 = require_error();
	exports.HASHEDREKORD_API_VERSION_V1 = "0.0.1";
	function verifyHashedRekordTLogBody(tlogEntry, content) {
		switch (tlogEntry.apiVersion) {
			case exports.HASHEDREKORD_API_VERSION_V1: return verifyHashedrekord001TLogBody(tlogEntry, content);
			default: throw new error_1.VerificationError({
				code: "TLOG_BODY_ERROR",
				message: `unsupported hashedrekord version: ${tlogEntry.apiVersion}`
			});
		}
	}
	function verifyHashedRekordTLogBodyV2(tlogEntry, content) {
		const spec = tlogEntry.spec?.spec;
		if (!spec) throw new error_1.VerificationError({
			code: "TLOG_BODY_ERROR",
			message: `missing dsse spec`
		});
		switch (spec.$case) {
			case "hashedRekordV002": return verifyHashedrekord002TLogBody(spec.hashedRekordV002, content);
			default: throw new error_1.VerificationError({
				code: "TLOG_BODY_ERROR",
				message: `unsupported version: ${spec.$case}`
			});
		}
	}
	function verifyHashedrekord001TLogBody(tlogEntry, content) {
		const tlogSig = tlogEntry.spec.signature.content || "";
		if (!content.compareSignature(Buffer.from(tlogSig, "base64"))) throw new error_1.VerificationError({
			code: "TLOG_BODY_ERROR",
			message: "signature mismatch"
		});
		const tlogDigest = tlogEntry.spec.data.hash?.value || "";
		if (!content.compareSignedDigest(Buffer.from(tlogDigest, "hex"))) throw new error_1.VerificationError({
			code: "TLOG_BODY_ERROR",
			message: "digest mismatch"
		});
	}
	function verifyHashedrekord002TLogBody(spec, content) {
		const tlogSig = spec.signature?.content || Buffer.from("");
		if (!content.compareSignature(tlogSig)) throw new error_1.VerificationError({
			code: "TLOG_BODY_ERROR",
			message: "signature mismatch"
		});
		const tlogHash = spec.data?.digest || Buffer.from("");
		if (!content.compareSignedDigest(tlogHash)) throw new error_1.VerificationError({
			code: "TLOG_BODY_ERROR",
			message: "digest mismatch"
		});
	}
}));
var require_intoto = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.verifyIntotoTLogBody = verifyIntotoTLogBody;
	const error_1 = require_error();
	function verifyIntotoTLogBody(tlogEntry, content) {
		switch (tlogEntry.apiVersion) {
			case "0.0.2": return verifyIntoto002TLogBody(tlogEntry, content);
			default: throw new error_1.VerificationError({
				code: "TLOG_BODY_ERROR",
				message: `unsupported intoto version: ${tlogEntry.apiVersion}`
			});
		}
	}
	function verifyIntoto002TLogBody(tlogEntry, content) {
		if (tlogEntry.spec.content.envelope.signatures?.length !== 1) throw new error_1.VerificationError({
			code: "TLOG_BODY_ERROR",
			message: "signature count mismatch"
		});
		const tlogSig = base64Decode(tlogEntry.spec.content.envelope.signatures[0].sig);
		if (!content.compareSignature(Buffer.from(tlogSig, "base64"))) throw new error_1.VerificationError({
			code: "TLOG_BODY_ERROR",
			message: "tlog entry signature mismatch"
		});
		const tlogHash = tlogEntry.spec.content.payloadHash?.value || "";
		if (!content.compareDigest(Buffer.from(tlogHash, "hex"))) throw new error_1.VerificationError({
			code: "TLOG_BODY_ERROR",
			message: "DSSE payload hash mismatch"
		});
	}
	function base64Decode(str) {
		return Buffer.from(str, "base64").toString("utf-8");
	}
}));
var require_checkpoint = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.LogCheckpoint = void 0;
	exports.verifyCheckpoint = verifyCheckpoint;
	const core_1 = require_dist$1();
	const error_1 = require_error();
	const CHECKPOINT_SEPARATOR = "\n\n";
	const SIGNATURE_REGEX = /\u2014 (\S+) (\S+)\n/g;
	function verifyCheckpoint(entry, tlogs) {
		const inclusionProof = entry.inclusionProof;
		const signedNote = SignedNote.fromString(inclusionProof.checkpoint.envelope);
		const checkpoint = LogCheckpoint.fromString(signedNote.note);
		if (!verifySignedNote(signedNote, tlogs)) throw new error_1.VerificationError({
			code: "TLOG_INCLUSION_PROOF_ERROR",
			message: "invalid checkpoint signature"
		});
		return checkpoint;
	}
	function verifySignedNote(signedNote, tlogs) {
		const data = Buffer.from(signedNote.note, "utf-8");
		return signedNote.signatures.some((signature) => {
			const tlog = tlogs.find((tlog) => core_1.crypto.bufferEqual(tlog.logID.subarray(0, 4), signature.keyHint) && tlog.baseURL.match(signature.name));
			if (!tlog) return false;
			return core_1.crypto.verify(data, tlog.publicKey, signature.signature);
		});
	}
	var SignedNote = class SignedNote {
		note;
		signatures;
		constructor(note, signatures) {
			this.note = note;
			this.signatures = signatures;
		}
		static fromString(envelope) {
			if (!envelope.includes(CHECKPOINT_SEPARATOR)) throw new error_1.VerificationError({
				code: "TLOG_INCLUSION_PROOF_ERROR",
				message: "missing checkpoint separator"
			});
			const split = envelope.indexOf(CHECKPOINT_SEPARATOR);
			const header = envelope.slice(0, split + 1);
			const matches = envelope.slice(split + 2).matchAll(SIGNATURE_REGEX);
			const signatures = Array.from(matches, (match) => {
				const [, name, signature] = match;
				const sigBytes = Buffer.from(signature, "base64");
				if (sigBytes.length < 5) throw new error_1.VerificationError({
					code: "TLOG_INCLUSION_PROOF_ERROR",
					message: "malformed checkpoint signature"
				});
				return {
					name,
					keyHint: sigBytes.subarray(0, 4),
					signature: sigBytes.subarray(4)
				};
			});
			if (signatures.length === 0) throw new error_1.VerificationError({
				code: "TLOG_INCLUSION_PROOF_ERROR",
				message: "no signatures found in checkpoint"
			});
			return new SignedNote(header, signatures);
		}
	};
	var LogCheckpoint = class LogCheckpoint {
		origin;
		logSize;
		logHash;
		rest;
		constructor(origin, logSize, logHash, rest) {
			this.origin = origin;
			this.logSize = logSize;
			this.logHash = logHash;
			this.rest = rest;
		}
		static fromString(note) {
			const lines = note.trimEnd().split("\n");
			if (lines.length < 3) throw new error_1.VerificationError({
				code: "TLOG_INCLUSION_PROOF_ERROR",
				message: "too few lines in checkpoint header"
			});
			const origin = lines[0];
			return new LogCheckpoint(origin, BigInt(lines[1]), Buffer.from(lines[2], "base64"), lines.slice(3));
		}
	};
	exports.LogCheckpoint = LogCheckpoint;
}));
var require_merkle = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.verifyMerkleInclusion = verifyMerkleInclusion;
	const core_1 = require_dist$1();
	const error_1 = require_error();
	const RFC6962_LEAF_HASH_PREFIX = Buffer.from([0]);
	const RFC6962_NODE_HASH_PREFIX = Buffer.from([1]);
	function verifyMerkleInclusion(entry, checkpoint) {
		const inclusionProof = entry.inclusionProof;
		const logIndex = BigInt(inclusionProof.logIndex);
		const treeSize = BigInt(checkpoint.logSize);
		if (logIndex < 0n || logIndex >= treeSize) throw new error_1.VerificationError({
			code: "TLOG_INCLUSION_PROOF_ERROR",
			message: `invalid index: ${logIndex}`
		});
		const { inner, border } = decompInclProof(logIndex, treeSize);
		if (inclusionProof.hashes.length !== inner + border) throw new error_1.VerificationError({
			code: "TLOG_INCLUSION_PROOF_ERROR",
			message: "invalid hash count"
		});
		const innerHashes = inclusionProof.hashes.slice(0, inner);
		const borderHashes = inclusionProof.hashes.slice(inner);
		const calculatedHash = chainBorderRight(chainInner(hashLeaf(entry.canonicalizedBody), innerHashes, logIndex), borderHashes);
		if (!core_1.crypto.bufferEqual(calculatedHash, checkpoint.logHash)) throw new error_1.VerificationError({
			code: "TLOG_INCLUSION_PROOF_ERROR",
			message: "calculated root hash does not match inclusion proof"
		});
	}
	function decompInclProof(index, size) {
		const inner = innerProofSize(index, size);
		return {
			inner,
			border: onesCount(index >> BigInt(inner))
		};
	}
	function chainInner(seed, hashes, index) {
		return hashes.reduce((acc, h, i) => {
			if (index >> BigInt(i) & BigInt(1)) return hashChildren(h, acc);
			else return hashChildren(acc, h);
		}, seed);
	}
	function chainBorderRight(seed, hashes) {
		return hashes.reduce((acc, h) => hashChildren(h, acc), seed);
	}
	function innerProofSize(index, size) {
		return bitLength(index ^ size - BigInt(1));
	}
	function onesCount(num) {
		return num.toString(2).split("1").length - 1;
	}
	function bitLength(n) {
		if (n === 0n) return 0;
		return n.toString(2).length;
	}
	function hashChildren(left, right) {
		return core_1.crypto.digest("sha256", RFC6962_NODE_HASH_PREFIX, left, right);
	}
	function hashLeaf(leaf) {
		return core_1.crypto.digest("sha256", RFC6962_LEAF_HASH_PREFIX, leaf);
	}
}));
var require_set = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.verifyTLogSET = verifyTLogSET;
	const core_1 = require_dist$1();
	const error_1 = require_error();
	const trust_1 = require_trust();
	function verifyTLogSET(entry, tlogs) {
		if (!(0, trust_1.filterTLogAuthorities)(tlogs, {
			logID: entry.logId.keyId,
			targetDate: /* @__PURE__ */ new Date(Number(entry.integratedTime) * 1e3)
		}).some((tlog) => {
			const payload = toVerificationPayload(entry);
			const data = Buffer.from(core_1.json.canonicalize(payload), "utf8");
			const signature = entry.inclusionPromise.signedEntryTimestamp;
			return core_1.crypto.verify(data, tlog.publicKey, signature);
		})) throw new error_1.VerificationError({
			code: "TLOG_INCLUSION_PROMISE_ERROR",
			message: "inclusion promise could not be verified"
		});
	}
	function toVerificationPayload(entry) {
		const { integratedTime, logIndex, logId, canonicalizedBody } = entry;
		return {
			body: canonicalizedBody.toString("base64"),
			integratedTime: Number(integratedTime),
			logIndex: Number(logIndex),
			logID: logId.keyId.toString("hex")
		};
	}
}));
var require_tlog = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.verifyTLogBody = verifyTLogBody;
	exports.verifyTLogInclusion = verifyTLogInclusion;
	const v2_1 = require_v2();
	const error_1 = require_error();
	const dsse_1 = require_dsse();
	const hashedrekord_1 = require_hashedrekord();
	const intoto_1 = require_intoto();
	const checkpoint_1 = require_checkpoint();
	const merkle_1 = require_merkle();
	const set_1 = require_set();
	function verifyTLogBody(entry, sigContent) {
		const { kind, version } = entry.kindVersion;
		const body = JSON.parse(entry.canonicalizedBody.toString("utf8"));
		if (kind !== body.kind || version !== body.apiVersion) throw new error_1.VerificationError({
			code: "TLOG_BODY_ERROR",
			message: `kind/version mismatch - expected: ${kind}/${version}, received: ${body.kind}/${body.apiVersion}`
		});
		switch (kind) {
			case "dsse": if (version == dsse_1.DSSE_API_VERSION_V1) return (0, dsse_1.verifyDSSETLogBody)(body, sigContent);
			else {
				const entryRekorV2 = v2_1.Entry.fromJSON(body);
				return (0, dsse_1.verifyDSSETLogBodyV2)(entryRekorV2, sigContent);
			}
			case "intoto": return (0, intoto_1.verifyIntotoTLogBody)(body, sigContent);
			case "hashedrekord": if (version == hashedrekord_1.HASHEDREKORD_API_VERSION_V1) return (0, hashedrekord_1.verifyHashedRekordTLogBody)(body, sigContent);
			else {
				const entryRekorV2 = v2_1.Entry.fromJSON(body);
				return (0, hashedrekord_1.verifyHashedRekordTLogBodyV2)(entryRekorV2, sigContent);
			}
			default: throw new error_1.VerificationError({
				code: "TLOG_BODY_ERROR",
				message: `unsupported kind: ${kind}`
			});
		}
	}
	function verifyTLogInclusion(entry, tlogAuthorities) {
		let inclusionVerified = false;
		if (isTLogEntryWithInclusionPromise(entry)) {
			(0, set_1.verifyTLogSET)(entry, tlogAuthorities);
			inclusionVerified = true;
		}
		if (isTLogEntryWithInclusionProof(entry)) {
			const checkpoint = (0, checkpoint_1.verifyCheckpoint)(entry, tlogAuthorities);
			(0, merkle_1.verifyMerkleInclusion)(entry, checkpoint);
			inclusionVerified = true;
		}
		if (!inclusionVerified) throw new error_1.VerificationError({
			code: "TLOG_MISSING_INCLUSION_ERROR",
			message: "inclusion could not be verified"
		});
	}
	function isTLogEntryWithInclusionPromise(entry) {
		return entry.inclusionPromise !== void 0;
	}
	function isTLogEntryWithInclusionProof(entry) {
		return entry.inclusionProof !== void 0;
	}
}));
var require_verifier = /* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Verifier = void 0;
	const util_1 = __require("util");
	const error_1 = require_error();
	const key_1 = require_key();
	const policy_1 = require_policy();
	const timestamp_1 = require_timestamp();
	const tlog_1 = require_tlog();
	var Verifier = class {
		trustMaterial;
		options;
		constructor(trustMaterial, options = {}) {
			this.trustMaterial = trustMaterial;
			this.options = {
				ctlogThreshold: options.ctlogThreshold ?? 1,
				tlogThreshold: options.tlogThreshold ?? 1,
				timestampThreshold: options.timestampThreshold ?? options.tsaThreshold ?? 1,
				tsaThreshold: 0
			};
		}
		verify(entity, policy) {
			const timestamps = this.verifyTimestamps(entity);
			const signer = this.verifySigningKey(entity, timestamps);
			this.verifyTLogs(entity);
			this.verifySignature(entity, signer);
			if (policy) this.verifyPolicy(policy, signer.identity || {});
			return signer;
		}
		verifyTimestamps(entity) {
			const timestamps = [];
			for (const timestamp of entity.timestamps) switch (timestamp.$case) {
				case "timestamp-authority":
					timestamps.push((0, timestamp_1.getTSATimestamp)(timestamp.timestamp, entity.signature.signature, this.trustMaterial.timestampAuthorities));
					break;
				case "transparency-log": {
					const result = (0, timestamp_1.getTLogTimestamp)(timestamp.tlogEntry);
					if (result) timestamps.push(result);
					break;
				}
			}
			if (containsDupes(timestamps)) throw new error_1.VerificationError({
				code: "TIMESTAMP_ERROR",
				message: "duplicate timestamp"
			});
			if (timestamps.length < this.options.timestampThreshold) throw new error_1.VerificationError({
				code: "TIMESTAMP_ERROR",
				message: `expected ${this.options.timestampThreshold} timestamps, got ${timestamps.length}`
			});
			return timestamps.map((t) => t.timestamp);
		}
		verifySigningKey({ key }, timestamps) {
			switch (key.$case) {
				case "public-key": return (0, key_1.verifyPublicKey)(key.hint, timestamps, this.trustMaterial);
				case "certificate": {
					const result = (0, key_1.verifyCertificate)(key.certificate, timestamps, this.trustMaterial);
					/* istanbul ignore next - no fixture */
					if (containsDupes(result.scts)) throw new error_1.VerificationError({
						code: "CERTIFICATE_ERROR",
						message: "duplicate SCT"
					});
					if (result.scts.length < this.options.ctlogThreshold) throw new error_1.VerificationError({
						code: "CERTIFICATE_ERROR",
						message: `expected ${this.options.ctlogThreshold} SCTs, got ${result.scts.length}`
					});
					return result.signer;
				}
			}
		}
		verifyTLogs({ signature: content, tlogEntries }) {
			let tlogCount = 0;
			tlogEntries.forEach((entry) => {
				tlogCount++;
				(0, tlog_1.verifyTLogInclusion)(entry, this.trustMaterial.tlogs);
				(0, tlog_1.verifyTLogBody)(entry, content);
			});
			if (tlogCount < this.options.tlogThreshold) throw new error_1.VerificationError({
				code: "TLOG_ERROR",
				message: `expected ${this.options.tlogThreshold} tlog entries, got ${tlogCount}`
			});
		}
		verifySignature(entity, signer) {
			if (!entity.signature.verifySignature(signer.key)) throw new error_1.VerificationError({
				code: "SIGNATURE_ERROR",
				message: "signature verification failed"
			});
		}
		verifyPolicy(policy, identity) {
			/* istanbul ignore else */
			if (policy.subjectAlternativeName) (0, policy_1.verifySubjectAlternativeName)(policy.subjectAlternativeName, identity.subjectAlternativeName);
			/* istanbul ignore else */
			if (policy.extensions) (0, policy_1.verifyExtensions)(policy.extensions, identity.extensions);
			/* istanbul ignore if */
			if (policy.oids) (0, policy_1.verifyOIDs)(policy.oids, identity.oids);
		}
	};
	exports.Verifier = Verifier;
	function containsDupes(arr) {
		for (let i = 0; i < arr.length; i++) for (let j = i + 1; j < arr.length; j++) if ((0, util_1.isDeepStrictEqual)(arr[i], arr[j])) return true;
		return false;
	}
}));
var import_dist$2 = (/* @__PURE__ */ __commonJSMin(((exports) => {
	Object.defineProperty(exports, "__esModule", { value: true });
	exports.Verifier = exports.toTrustMaterial = exports.VerificationError = exports.PolicyError = exports.toSignedEntity = void 0;
	/* istanbul ignore file */
	var bundle_1 = require_bundle();
	Object.defineProperty(exports, "toSignedEntity", {
		enumerable: true,
		get: function() {
			return bundle_1.toSignedEntity;
		}
	});
	var error_1 = require_error();
	Object.defineProperty(exports, "PolicyError", {
		enumerable: true,
		get: function() {
			return error_1.PolicyError;
		}
	});
	Object.defineProperty(exports, "VerificationError", {
		enumerable: true,
		get: function() {
			return error_1.VerificationError;
		}
	});
	var trust_1 = require_trust();
	Object.defineProperty(exports, "toTrustMaterial", {
		enumerable: true,
		get: function() {
			return trust_1.toTrustMaterial;
		}
	});
	var verifier_1 = require_verifier();
	Object.defineProperty(exports, "Verifier", {
		enumerable: true,
		get: function() {
			return verifier_1.Verifier;
		}
	});
})))();
var import_dist = require_dist$2();
var import_dist$1 = require_dist$3();
var sigstore_public_good_v1_default = {
	mediaType: "application/vnd.dev.sigstore.trustedroot+json;version=0.1",
	tlogs: [{
		"baseUrl": "https://rekor.sigstore.dev",
		"hashAlgorithm": "SHA2_256",
		"publicKey": {
			"rawBytes": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAE2G2Y+2tabdTV5BcGiBIx0a9fAFwrkBbmLSGtks4L3qX6yYY0zufBnhC8Ur/iy55GhWP/9A/bY2LhC30M9+RYtw==",
			"keyDetails": "PKIX_ECDSA_P256_SHA_256",
			"validFor": { "start": "2021-01-12T11:53:27Z" }
		},
		"logId": { "keyId": "wNI9atQGlz+VWfO6LRygH4QUfY/8W4RFwiT5i5WRgB0=" }
	}, {
		"baseUrl": "https://log2025-1.rekor.sigstore.dev",
		"hashAlgorithm": "SHA2_256",
		"publicKey": {
			"rawBytes": "MCowBQYDK2VwAyEAt8rlp1knGwjfbcXAYPYAkn0XiLz1x8O4t0YkEhie244=",
			"keyDetails": "PKIX_ED25519",
			"validFor": { "start": "2025-09-23T00:00:00Z" }
		},
		"logId": { "keyId": "zxGZFVvd0FEmjR8WrFwMdcAJ9vtaY/QXf44Y1wUeP6A=" }
	}],
	certificateAuthorities: [{
		"subject": {
			"organization": "sigstore.dev",
			"commonName": "sigstore"
		},
		"uri": "https://fulcio.sigstore.dev",
		"certChain": { "certificates": [{ "rawBytes": "MIIB+DCCAX6gAwIBAgITNVkDZoCiofPDsy7dfm6geLbuhzAKBggqhkjOPQQDAzAqMRUwEwYDVQQKEwxzaWdzdG9yZS5kZXYxETAPBgNVBAMTCHNpZ3N0b3JlMB4XDTIxMDMwNzAzMjAyOVoXDTMxMDIyMzAzMjAyOVowKjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREwDwYDVQQDEwhzaWdzdG9yZTB2MBAGByqGSM49AgEGBSuBBAAiA2IABLSyA7Ii5k+pNO8ZEWY0ylemWDowOkNa3kL+GZE5Z5GWehL9/A9bRNA3RbrsZ5i0JcastaRL7Sp5fp/jD5dxqc/UdTVnlvS16an+2Yfswe/QuLolRUCrcOE2+2iA5+tzd6NmMGQwDgYDVR0PAQH/BAQDAgEGMBIGA1UdEwEB/wQIMAYBAf8CAQEwHQYDVR0OBBYEFMjFHQBBmiQpMlEk6w2uSu1KBtPsMB8GA1UdIwQYMBaAFMjFHQBBmiQpMlEk6w2uSu1KBtPsMAoGCCqGSM49BAMDA2gAMGUCMH8liWJfMui6vXXBhjDgY4MwslmN/TJxVe/83WrFomwmNf056y1X48F9c4m3a3ozXAIxAKjRay5/aj/jsKKGIkmQatjI8uupHr/+CxFvaJWmpYqNkLDGRU+9orzh5hI2RrcuaQ==" }] },
		"validFor": {
			"start": "2021-03-07T03:20:29Z",
			"end": "2022-12-31T23:59:59.999Z"
		}
	}, {
		"subject": {
			"organization": "sigstore.dev",
			"commonName": "sigstore"
		},
		"uri": "https://fulcio.sigstore.dev",
		"certChain": { "certificates": [{ "rawBytes": "MIICGjCCAaGgAwIBAgIUALnViVfnU0brJasmRkHrn/UnfaQwCgYIKoZIzj0EAwMwKjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREwDwYDVQQDEwhzaWdzdG9yZTAeFw0yMjA0MTMyMDA2MTVaFw0zMTEwMDUxMzU2NThaMDcxFTATBgNVBAoTDHNpZ3N0b3JlLmRldjEeMBwGA1UEAxMVc2lnc3RvcmUtaW50ZXJtZWRpYXRlMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE8RVS/ysH+NOvuDZyPIZtilgUF9NlarYpAd9HP1vBBH1U5CV77LSS7s0ZiH4nE7Hv7ptS6LvvR/STk798LVgMzLlJ4HeIfF3tHSaexLcYpSASr1kS0N/RgBJz/9jWCiXno3sweTAOBgNVHQ8BAf8EBAMCAQYwEwYDVR0lBAwwCgYIKwYBBQUHAwMwEgYDVR0TAQH/BAgwBgEB/wIBADAdBgNVHQ4EFgQU39Ppz1YkEZb5qNjpKFWixi4YZD8wHwYDVR0jBBgwFoAUWMAeX5FFpWapesyQoZMi0CrFxfowCgYIKoZIzj0EAwMDZwAwZAIwPCsQK4DYiZYDPIaDi5HFKnfxXx6ASSVmERfsynYBiX2X6SJRnZU84/9DZdnFvvxmAjBOt6QpBlc4J/0DxvkTCqpclvziL6BCCPnjdlIB3Pu3BxsPmygUY7Ii2zbdCdliiow=" }, { "rawBytes": "MIIB9zCCAXygAwIBAgIUALZNAPFdxHPwjeDloDwyYChAO/4wCgYIKoZIzj0EAwMwKjEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MREwDwYDVQQDEwhzaWdzdG9yZTAeFw0yMTEwMDcxMzU2NTlaFw0zMTEwMDUxMzU2NThaMCoxFTATBgNVBAoTDHNpZ3N0b3JlLmRldjERMA8GA1UEAxMIc2lnc3RvcmUwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAT7XeFT4rb3PQGwS4IajtLk3/OlnpgangaBclYpsYBr5i+4ynB07ceb3LP0OIOZdxexX69c5iVuyJRQ+Hz05yi+UF3uBWAlHpiS5sh0+H2GHE7SXrk1EC5m1Tr19L9gg92jYzBhMA4GA1UdDwEB/wQEAwIBBjAPBgNVHRMBAf8EBTADAQH/MB0GA1UdDgQWBBRYwB5fkUWlZql6zJChkyLQKsXF+jAfBgNVHSMEGDAWgBRYwB5fkUWlZql6zJChkyLQKsXF+jAKBggqhkjOPQQDAwNpADBmAjEAj1nHeXZp+13NWBNa+EDsDP8G1WWg1tCMWP/WHPqpaVo0jhsweNFZgSs0eE7wYI4qAjEA2WB9ot98sIkoF3vZYdd3/VtWB5b9TNMea7Ix/stJ5TfcLLeABLE4BNJOsQ4vnBHJ" }] },
		"validFor": { "start": "2022-04-13T20:06:15Z" }
	}],
	ctlogs: [{
		"baseUrl": "https://ctfe.sigstore.dev/test",
		"hashAlgorithm": "SHA2_256",
		"publicKey": {
			"rawBytes": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEbfwR+RJudXscgRBRpKX1XFDy3PyudDxz/SfnRi1fT8ekpfBd2O1uoz7jr3Z8nKzxA69EUQ+eFCFI3zeubPWU7w==",
			"keyDetails": "PKIX_ECDSA_P256_SHA_256",
			"validFor": {
				"start": "2021-03-14T00:00:00Z",
				"end": "2022-10-31T23:59:59.999Z"
			}
		},
		"logId": { "keyId": "CGCS8ChS/2hF0dFrJ4ScRWcYrBY9wzjSbea8IgY2b3I=" }
	}, {
		"baseUrl": "https://ctfe.sigstore.dev/2022",
		"hashAlgorithm": "SHA2_256",
		"publicKey": {
			"rawBytes": "MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEiPSlFi0CmFTfEjCUqF9HuCEcYXNKAaYalIJmBZ8yyezPjTqhxrKBpMnaocVtLJBI1eM3uXnQzQGAJdJ4gs9Fyw==",
			"keyDetails": "PKIX_ECDSA_P256_SHA_256",
			"validFor": { "start": "2022-10-20T00:00:00Z" }
		},
		"logId": { "keyId": "3T0wasbHETJjGR4cmWc3AqJKXrjePK3/h4pygC8p7o4=" }
	}],
	timestampAuthorities: [{
		"subject": {
			"organization": "sigstore.dev",
			"commonName": "sigstore-tsa-selfsigned"
		},
		"uri": "https://timestamp.sigstore.dev/api/v1/timestamp",
		"certChain": { "certificates": [{ "rawBytes": "MIICEDCCAZagAwIBAgIUOhNULwyQYe68wUMvy4qOiyojiwwwCgYIKoZIzj0EAwMwOTEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MSAwHgYDVQQDExdzaWdzdG9yZS10c2Etc2VsZnNpZ25lZDAeFw0yNTA0MDgwNjU5NDNaFw0zNTA0MDYwNjU5NDNaMC4xFTATBgNVBAoTDHNpZ3N0b3JlLmRldjEVMBMGA1UEAxMMc2lnc3RvcmUtdHNhMHYwEAYHKoZIzj0CAQYFK4EEACIDYgAE4ra2Z8hKNig2T9kFjCAToGG30jky+WQv3BzL+mKvh1SKNR/UwuwsfNCg4sryoYAd8E6isovVA3M4aoNdm9QDi50Z8nTEyvqgfDPtTIwXItfiW/AFf1V7uwkbkAoj0xxco2owaDAOBgNVHQ8BAf8EBAMCB4AwHQYDVR0OBBYEFIn9eUOHz9BlRsMCRscsc1t9tOsDMB8GA1UdIwQYMBaAFJjsAe9/u1H/1JUeb4qImFMHic6/MBYGA1UdJQEB/wQMMAoGCCsGAQUFBwMIMAoGCCqGSM49BAMDA2gAMGUCMDtpsV/6KaO0qyF/UMsX2aSUXKQFdoGTptQGc0ftq1csulHPGG6dsmyMNd3JB+G3EQIxAOajvBcjpJmKb4Nv+2Taoj8Uc5+b6ih6FXCCKraSqupe07zqswMcXJTe1cExvHvvlw==" }, { "rawBytes": "MIIB9zCCAXygAwIBAgIUV7f0GLDOoEzIh8LXSW80OJiUp14wCgYIKoZIzj0EAwMwOTEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MSAwHgYDVQQDExdzaWdzdG9yZS10c2Etc2VsZnNpZ25lZDAeFw0yNTA0MDgwNjU5NDNaFw0zNTA0MDYwNjU5NDNaMDkxFTATBgNVBAoTDHNpZ3N0b3JlLmRldjEgMB4GA1UEAxMXc2lnc3RvcmUtdHNhLXNlbGZzaWduZWQwdjAQBgcqhkjOPQIBBgUrgQQAIgNiAAQUQNtfRT/ou3YATa6wB/kKTe70cfJwyRIBovMnt8RcJph/COE82uyS6FmppLLL1VBPGcPfpQPYJNXzWwi8icwhKQ6W/Qe2h3oebBb2FHpwNJDqo+TMaC/tdfkv/ElJB72jRTBDMA4GA1UdDwEB/wQEAwIBBjASBgNVHRMBAf8ECDAGAQH/AgEAMB0GA1UdDgQWBBSY7AHvf7tR/9SVHm+KiJhTB4nOvzAKBggqhkjOPQQDAwNpADBmAjEAwGEGrfGZR1cen1R8/DTVMI943LssZmJRtDp/i7SfGHmGRP6gRbuj9vOK3b67Z0QQAjEAuT2H673LQEaHTcyQSZrkp4mX7WwkmF+sVbkYY5mXN+RMH13KUEHHOqASaemYWK/E" }] },
		"validFor": { "start": "2025-07-04T00:00:00Z" }
	}]
};
const decoder$2 = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: false
});
const verifier = new import_dist$2.Verifier((0, import_dist$2.toTrustMaterial)(import_dist$1.TrustedRoot.fromJSON(sigstore_public_good_v1_default)), {
	tlogThreshold: 1,
	ctlogThreshold: 1,
	timestampThreshold: 1
});

//#endregion
//#region ../../packages/registry-verification/dist/errors-CI-j3m_y.js
function verificationError(code, message, details) {
	return {
		success: false,
		error: {
			code,
			message,
			...details === void 0 ? {} : { details }
		}
	};
}

//#endregion
//#region ../../packages/registry-verification/dist/bundle.js
/** Maximum accepted gzip payload size. */
const MAX_BUNDLE_COMPRESSED_BYTES = 384 * 1024;
/** Maximum aggregate size of regular-file contents. */
const MAX_BUNDLE_SIZE = 256 * 1024;
/** Maximum size of one regular file. */
const MAX_BUNDLE_FILE_BYTES = 128 * 1024;
/** Maximum number of regular files. */
const MAX_BUNDLE_FILE_COUNT = 20;
/** Maximum total tar entries, including harmless directory entries. */
const MAX_BUNDLE_TAR_ENTRY_COUNT = 32;
/**
* Maximum tar stream size after decompression. This includes USTAR headers,
* file padding, and the end marker in addition to the regular-file contents.
*/
const MAX_BUNDLE_DECOMPRESSED_BYTES = MAX_BUNDLE_SIZE + MAX_BUNDLE_TAR_ENTRY_COUNT * 512 + MAX_BUNDLE_FILE_COUNT * 511 + 2 * 512;
const TAR_BLOCK_BYTES = 512;
const TAR_END_BYTES = TAR_BLOCK_BYTES * 2;
const OCTAL_PATTERN = /^[0-7]+$/;
const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:/;
const decoder = new TextDecoder("utf-8", {
	fatal: true,
	ignoreBOM: false
});
async function validatePluginBundle(compressed, options = {}) {
	if (compressed.byteLength > MAX_BUNDLE_COMPRESSED_BYTES) return verificationError("BUNDLE_COMPRESSED_SIZE_EXCEEDED", "The compressed plugin bundle exceeds the size limit.");
	const decompressed = await decompressBundle(compressed);
	if (!decompressed.success) return decompressed;
	const files = parseTar(decompressed.value);
	if (!files.success) return files;
	const manifestFile = files.value.get("manifest.json");
	if (!manifestFile) return verificationError("BUNDLE_MISSING_MANIFEST", "The plugin bundle is missing manifest.json.");
	const backend = files.value.get("backend.js");
	if (!backend) return verificationError("BUNDLE_MISSING_BACKEND", "The plugin bundle is missing backend.js.");
	let parsed;
	try {
		parsed = JSON.parse(decoder.decode(manifestFile.data));
	} catch {
		return verificationError("BUNDLE_INVALID_MANIFEST", "The plugin bundle manifest is not valid JSON.");
	}
	const validated = pluginManifestSchema.safeParse(parsed);
	if (!validated.success) return verificationError("BUNDLE_INVALID_MANIFEST", "The plugin bundle manifest failed schema validation.");
	const manifest = reconcileManifestAccess(validated.data);
	if (options.expectedSlug !== void 0 && manifest.id !== options.expectedSlug) return verificationError("BUNDLE_ID_MISMATCH", "The plugin bundle manifest id does not match the expected plugin.");
	if (options.expectedVersion !== void 0 && manifest.version !== options.expectedVersion) return verificationError("BUNDLE_VERSION_MISMATCH", "The plugin bundle manifest version does not match the expected version.");
	const result = {
		manifest,
		declaredAccess: manifest.declaredAccess ?? {},
		backend: backend.data
	};
	const admin = files.value.get("admin.js");
	if (admin) result.admin = admin.data;
	return {
		success: true,
		value: result
	};
}
async function decompressBundle(bytes) {
	const source = new ReadableStream({ start(controller) {
		controller.enqueue(bytes);
		controller.close();
	} });
	let reader;
	try {
		reader = source.pipeThrough(createGzipDecoder()).getReader();
	} catch {
		return verificationError("BUNDLE_INVALID_ARCHIVE", "The plugin bundle is not valid gzip data.");
	}
	const chunks = [];
	let total = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > MAX_BUNDLE_DECOMPRESSED_BYTES) {
				await reader.cancel().catch(() => void 0);
				return verificationError("BUNDLE_DECOMPRESSED_SIZE_EXCEEDED", "The decompressed plugin bundle exceeds the size limit.");
			}
			chunks.push(value);
		}
	} catch {
		return verificationError("BUNDLE_INVALID_ARCHIVE", "The plugin bundle is not valid gzip data.");
	}
	const output = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		output.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return {
		success: true,
		value: output
	};
}
function parseTar(bytes) {
	if (bytes.byteLength < TAR_END_BYTES || bytes.byteLength % TAR_BLOCK_BYTES !== 0) return invalidArchive();
	const files = /* @__PURE__ */ new Map();
	const rawPaths = /* @__PURE__ */ new Set();
	const normalizedPaths = /* @__PURE__ */ new Set();
	let offset = 0;
	let fileCount = 0;
	let entryCount = 0;
	let totalFileBytes = 0;
	let ended = false;
	while (offset + TAR_BLOCK_BYTES <= bytes.byteLength) {
		const header = bytes.subarray(offset, offset + TAR_BLOCK_BYTES);
		if (isZeroBlock(header)) {
			if (!isZeroBlock(bytes.subarray(offset + TAR_BLOCK_BYTES, offset + TAR_END_BYTES))) return invalidArchive();
			if (bytes.subarray(offset + TAR_END_BYTES).some((byte) => byte !== 0)) return invalidArchive();
			ended = true;
			break;
		}
		if (!validChecksum(header)) return invalidArchive();
		entryCount += 1;
		if (entryCount > MAX_BUNDLE_TAR_ENTRY_COUNT) return verificationError("BUNDLE_FILE_COUNT_EXCEEDED", "The plugin bundle contains too many archive entries.");
		const rawName = readTarPath(header);
		if (!rawName.success) return rawName;
		const typeFlag = header[156];
		const type = typeFlag === 0 ? "file" : String.fromCharCode(typeFlag ?? 0);
		const isDirectory = type === "5";
		const normalized = normalizePath(rawName.value, isDirectory);
		if (!normalized.success) return normalized;
		if (rawPaths.has(rawName.value) || normalizedPaths.has(normalized.value)) return verificationError("BUNDLE_PATH_COLLISION", "The plugin bundle contains duplicate or ambiguous paths.");
		rawPaths.add(rawName.value);
		normalizedPaths.add(normalized.value);
		const size = readOctal(header.subarray(124, 136));
		if (size === null || !Number.isSafeInteger(size)) return invalidArchive();
		const bodyStart = offset + TAR_BLOCK_BYTES;
		const nextOffset = bodyStart + Math.ceil(size / TAR_BLOCK_BYTES) * TAR_BLOCK_BYTES;
		if (nextOffset > bytes.byteLength) return invalidArchive();
		if (isDirectory) {
			if (size !== 0) return invalidArchive();
		} else if (type === "file" || type === "0") {
			fileCount += 1;
			if (fileCount > MAX_BUNDLE_FILE_COUNT) return verificationError("BUNDLE_FILE_COUNT_EXCEEDED", "The plugin bundle contains too many files.");
			if (size > MAX_BUNDLE_FILE_BYTES) return verificationError("BUNDLE_FILE_SIZE_EXCEEDED", "A file in the plugin bundle exceeds the per-file size limit.");
			totalFileBytes += size;
			if (totalFileBytes > MAX_BUNDLE_SIZE) return verificationError("BUNDLE_DECOMPRESSED_SIZE_EXCEEDED", "The plugin bundle file contents exceed the size limit.");
			files.set(normalized.value, {
				name: normalized.value,
				data: bytes.slice(bodyStart, bodyStart + size)
			});
		} else return verificationError("BUNDLE_UNSUPPORTED_ENTRY", "The plugin bundle contains an unsupported archive entry type.");
		offset = nextOffset;
	}
	if (!ended) return invalidArchive();
	return {
		success: true,
		value: files
	};
}
function readTarPath(header) {
	const name = readTarString(header.subarray(0, 100));
	const prefix = readTarString(header.subarray(345, 500));
	if (name === null || prefix === null || name.length === 0) return verificationError("BUNDLE_INVALID_PATH", "The plugin bundle contains a malformed path.");
	return {
		success: true,
		value: prefix ? `${prefix}/${name}` : name
	};
}
function readTarString(field) {
	const terminator = field.indexOf(0);
	const end = terminator === -1 ? field.length : terminator;
	if (terminator !== -1 && field.subarray(terminator + 1).some((byte) => byte !== 0)) return null;
	try {
		return decoder.decode(field.subarray(0, end));
	} catch {
		return null;
	}
}
function normalizePath(raw, isDirectory) {
	if (raw.includes("\\") || raw.startsWith("/") || WINDOWS_DRIVE_PATTERN.test(raw) || hasControlCharacter(raw) || raw.endsWith("/") !== isDirectory) return verificationError("BUNDLE_INVALID_PATH", "The plugin bundle contains an unsafe path.");
	const parts = raw.split("/");
	if (isDirectory) parts.pop();
	const normalized = [];
	for (const part of parts) {
		if (part === ".") continue;
		if (part === "" || part === "..") return verificationError("BUNDLE_INVALID_PATH", "The plugin bundle contains an unsafe path.");
		normalized.push(part.normalize("NFC"));
	}
	if (normalized.length === 0) return verificationError("BUNDLE_INVALID_PATH", "The plugin bundle contains a malformed path.");
	return {
		success: true,
		value: normalized.join("/")
	};
}
function hasControlCharacter(value) {
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== void 0 && (codePoint <= 31 || codePoint === 127)) return true;
	}
	return false;
}
function readOctal(field) {
	const text = new TextDecoder().decode(field).replaceAll("\0", "").trim();
	if (!OCTAL_PATTERN.test(text)) return null;
	const value = Number.parseInt(text, 8);
	return Number.isSafeInteger(value) ? value : null;
}
function validChecksum(header) {
	const expected = readOctal(header.subarray(148, 156));
	if (expected === null) return false;
	let actual = 0;
	for (let index = 0; index < header.length; index += 1) actual += index >= 148 && index < 156 ? 32 : header[index] ?? 0;
	return actual === expected;
}
function isZeroBlock(block) {
	return block.byteLength === TAR_BLOCK_BYTES && block.every((byte) => byte === 0);
}
function invalidArchive() {
	return verificationError("BUNDLE_INVALID_ARCHIVE", "The plugin bundle is not a valid tar archive.");
}

//#endregion
//#region ../../packages/registry-verification/dist/checksum.js
const SHA2_256_CODE = 18;
const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";
async function computeMultihash(bytes, algorithm = "sha2-256") {
	if (algorithm !== "sha2-256") return verificationError("UNSUPPORTED_MULTIHASH", "The multihash algorithm is not supported.");
	try {
		const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new Uint8Array(bytes)));
		const multihash = new Uint8Array(2 + digest.length);
		multihash[0] = SHA2_256_CODE;
		multihash[1] = digest.length;
		multihash.set(digest, 2);
		return {
			success: true,
			value: `b${encodeBase32(multihash)}`
		};
	} catch {
		return verificationError("UNSUPPORTED_MULTIHASH", "The sha2-256 algorithm is unavailable.");
	}
}
function encodeBase32(bytes) {
	let result = "";
	let buffer = 0;
	let bits = 0;
	for (const byte of bytes) {
		buffer = buffer << 8 | byte;
		bits += 8;
		while (bits >= 5) {
			result += BASE32_ALPHABET[buffer >>> bits - 5 & 31] ?? "";
			bits -= 5;
		}
	}
	if (bits > 0) result += BASE32_ALPHABET[buffer << 5 - bits & 31] ?? "";
	return result;
}

//#endregion
//#region src/prepare.ts
const MAX_PROVENANCE_BYTES = 5 * 1024 * 1024;
const REPOSITORY_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const WORKFLOW_REF_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/\.github\/workflows\/[A-Za-z0-9_./-]+\.ya?ml@refs\/[A-Za-z0-9._/-]+$/;
var ReleasePreparationError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ReleasePreparationError";
	}
};
async function runBundleCommand(options) {
	await new Promise((resolvePromise, reject) => {
		const child = spawn("pnpm", [
			"exec",
			"emdash-plugin",
			"bundle",
			"--dir",
			options.dir,
			"--out-dir",
			options.outDir
		], {
			cwd: options.dir,
			stdio: "inherit",
			shell: false
		});
		child.once("error", () => reject(new ReleasePreparationError("Plugin build could not start")));
		child.once("exit", (code, signal) => {
			if (code === 0 && signal === null) resolvePromise();
			else reject(new ReleasePreparationError("Plugin build failed"));
		});
	});
	const outputDirectory = resolve(options.dir, options.outDir);
	const tarballs = (await readdir(outputDirectory)).filter((name) => name.endsWith(".tar.gz")).map((name) => join(outputDirectory, name));
	if (tarballs.length !== 1) throw new ReleasePreparationError("Plugin build did not produce exactly one bundle");
	return { tarballPath: tarballs[0] ?? null };
}
async function trustedPath(root, candidate, label) {
	try {
		const trustedRoot = await realpath(root);
		const path = await realpath(resolve(trustedRoot, candidate));
		const rel = relative(trustedRoot, path);
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("outside root");
		if (!(await stat(path)).isFile()) throw new Error("not a file");
		return path;
	} catch {
		throw new ReleasePreparationError(`${label} could not be read`);
	}
}
async function boundedFile(root, path, maximum, label) {
	const trusted = await trustedPath(root, path, label);
	const metadata = await stat(trusted);
	if (metadata.size < 1 || metadata.size > maximum) throw new ReleasePreparationError(`${label} is outside the supported size range`);
	const bytes = await readFile(trusted);
	if (bytes.byteLength !== metadata.size || bytes.byteLength > maximum) throw new ReleasePreparationError(`${label} changed while it was being read`);
	return new Uint8Array(bytes);
}
async function checksum(bytes) {
	const result = await computeMultihash(bytes);
	if (!result.success) throw new ReleasePreparationError("Release checksum could not be computed");
	return result.value;
}
async function validateBundle(bytes) {
	const result = await validatePluginBundle(bytes);
	return result.success ? {
		success: true,
		value: {
			packageSlug: result.value.manifest.id,
			version: result.value.manifest.version,
			declaredAccess: result.value.declaredAccess
		}
	} : {
		success: false,
		code: result.error.code
	};
}
async function prepareReleaseFiles(options, dependencies = {}) {
	if (options.repositoryVisibility !== "public") throw new ReleasePreparationError("Automatic provenance is currently supported only for public GitHub repositories");
	if (!REPOSITORY_PATTERN.test(options.repository) || !WORKFLOW_REF_PATTERN.test(options.workflowRef) || !options.workflowRef.startsWith(`${options.repository}/.github/workflows/`)) throw new ReleasePreparationError("GitHub repository or workflow identity is invalid");
	let bundleFile = options.bundleFile;
	if (!bundleFile) {
		const pluginDirectory = await realpath(resolve(options.workspace, options.pluginDirectory ?? ".")).catch(() => {
			throw new ReleasePreparationError("Plugin directory could not be read");
		});
		const rel = relative(await realpath(options.workspace), pluginDirectory);
		if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new ReleasePreparationError("Plugin directory could not be read");
		const bundled = await (dependencies.bundlePlugin ?? runBundleCommand)({
			dir: pluginDirectory,
			outDir: ".emdash-release"
		});
		if (!bundled.tarballPath) throw new ReleasePreparationError("Plugin build did not produce a bundle");
		bundleFile = bundled.tarballPath;
	}
	const [packageBytes, provenanceBytes] = await Promise.all([boundedFile(options.workspace, bundleFile, MAX_BUNDLE_COMPRESSED_BYTES$1, "Bundle file"), boundedFile(options.runnerTemp, options.provenanceFile, MAX_PROVENANCE_BYTES, "Provenance file")]);
	const bundle = await (dependencies.validateBundle ?? validateBundle)(packageBytes);
	if (!bundle.success) throw new ReleasePreparationError(`Plugin bundle is invalid (${bundle.code})`);
	const computeChecksum = dependencies.computeChecksum ?? checksum;
	return {
		packageSlug: bundle.value.packageSlug,
		version: bundle.value.version,
		packageBytes,
		packageChecksum: await computeChecksum(packageBytes),
		provenanceBytes,
		provenanceChecksum: await computeChecksum(provenanceBytes),
		declaredAccess: bundle.value.declaredAccess,
		sourceRepository: `https://github.com/${options.repository}`,
		builderId: `https://github.com/${options.workflowRef}`
	};
}

//#endregion
//#region src/run.ts
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const MAX_RELEASE_FILE_BYTES = 128 * 1024;
const FAILURE_STATES = new Set([
	"invalid",
	"rejected",
	"cancelled",
	"expired",
	"failed",
	"conflict"
]);
var ActionConfigurationError = class extends Error {
	constructor(message) {
		super(message);
		this.name = "ActionConfigurationError";
	}
};
function parsePositiveInteger(value, name, maximum) {
	if (!POSITIVE_INTEGER_PATTERN.test(value)) throw new ActionConfigurationError(`${name} must be a positive integer`);
	const parsed = Number(value);
	if (!Number.isSafeInteger(parsed) || parsed > maximum) throw new ActionConfigurationError(`${name} is outside the supported range`);
	return parsed;
}
function parseBoolean(value, name) {
	if (value === "true") return true;
	if (value === "false") return false;
	throw new ActionConfigurationError(`${name} must be true or false`);
}
async function defaultReadReleaseRecord(path, workspace) {
	try {
		const workspacePath = await realpath(workspace);
		const candidate = await realpath(resolve(workspacePath, path));
		const relativePath = relative(workspacePath, candidate);
		if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error("outside workspace");
		const metadata = await stat(candidate);
		if (!metadata.isFile() || metadata.size > MAX_RELEASE_FILE_BYTES) throw new Error("invalid release file");
		return JSON.parse(await readFile(candidate, "utf8"));
	} catch {
		throw new ActionConfigurationError("Release record file could not be read");
	}
}
function defaultIdempotencyKey(runtime) {
	const runId = runtime.getEnvironment("GITHUB_RUN_ID");
	if (!runId || !POSITIVE_INTEGER_PATTERN.test(runId)) throw new ActionConfigurationError("GitHub run identity is unavailable");
	return `github-run-${runId}`;
}
async function setIntentOutputs(runtime, intent) {
	await runtime.setOutput("intent-id", intent.id);
	await runtime.setOutput("state", intent.state);
	await runtime.setOutput("approval-url", intent.approvalUrl ?? "");
	await runtime.setOutput("release-uri", intent.result?.uri ?? "");
	await runtime.setOutput("release-cid", intent.result?.cid ?? "");
	await runtime.setOutput("reason-code", intent.reasonCode ?? "");
}
function sourceReleaseFromPrepared(prepared, packageUrl, provenanceUrl) {
	const release = parseDelegatedReleaseSourceRecord({
		$type: NSID.packageRelease,
		package: prepared.packageSlug,
		version: prepared.version,
		artifacts: { package: {
			url: packageUrl,
			checksum: prepared.packageChecksum,
			contentType: "application/gzip"
		} },
		extensions: { [NSID.packageReleaseExtension]: {
			$type: NSID.packageReleaseExtension,
			declaredAccess: prepared.declaredAccess,
			provenance: {
				url: provenanceUrl,
				checksum: prepared.provenanceChecksum,
				predicateType: "https://slsa.dev/provenance/v1",
				sourceRepository: prepared.sourceRepository,
				builderId: prepared.builderId
			}
		} }
	});
	if (!release) throw new ActionConfigurationError("Prepared release record is invalid");
	return release;
}
async function runAction(runtime, dependencies = {}) {
	const serviceUrl = runtime.getInput("service-url", { required: true });
	const publisherDid = runtime.getInput("publisher-did", { required: true });
	if (!/* @__PURE__ */ isDid(publisherDid)) throw new ActionConfigurationError("publisher-did must be a valid DID");
	const workspace = runtime.getEnvironment("GITHUB_WORKSPACE");
	if (!workspace) throw new ActionConfigurationError("GitHub workspace is unavailable");
	const releaseFile = runtime.getInput("release-file");
	const bundleFile = runtime.getInput("bundle-file");
	const provenanceFile = runtime.getInput("provenance-file");
	let prepared = null;
	let release = null;
	if (releaseFile) {
		if (bundleFile || provenanceFile) throw new ActionConfigurationError("release-file cannot be combined with bundle-file or provenance-file");
		release = parseDelegatedReleaseSourceRecord(await (dependencies.readReleaseRecord ?? defaultReadReleaseRecord)(releaseFile, workspace));
		if (!release) throw new ActionConfigurationError("Release record file is invalid");
	} else {
		if (!provenanceFile) throw new ActionConfigurationError("provenance-file is required for project or bundle releases");
		const runnerTemp = runtime.getEnvironment("RUNNER_TEMP");
		const repository = runtime.getEnvironment("GITHUB_REPOSITORY");
		const workflowRef = runtime.getEnvironment("GITHUB_WORKFLOW_REF");
		const repositoryVisibility = runtime.getEnvironment("GITHUB_REPOSITORY_VISIBILITY");
		if (!runnerTemp || !repository || !workflowRef || !repositoryVisibility) throw new ActionConfigurationError("GitHub workflow identity is unavailable");
		prepared = await (dependencies.prepareReleaseFiles ?? prepareReleaseFiles)({
			workspace,
			runnerTemp,
			...bundleFile ? { bundleFile } : {},
			pluginDirectory: runtime.getInput("plugin-directory") || ".",
			provenanceFile,
			repository,
			workflowRef,
			repositoryVisibility
		});
	}
	const packageSlug = prepared?.packageSlug ?? release.package;
	const version = prepared?.version ?? release.version;
	const idempotencyKey = runtime.getInput("idempotency-key") || defaultIdempotencyKey(runtime);
	const runId = runtime.getEnvironment("GITHUB_RUN_ID");
	if (!runId || !POSITIVE_INTEGER_PATTERN.test(runId)) throw new ActionConfigurationError("GitHub run identity is unavailable");
	const pollIntervalSeconds = parsePositiveInteger(runtime.getInput("poll-interval-seconds") || "5", "poll-interval-seconds", 300);
	const timeoutMinutes = parsePositiveInteger(runtime.getInput("timeout-minutes") || "30", "timeout-minutes", 360);
	const waitForApproval = parseBoolean(runtime.getInput("wait-for-approval") || "false", "wait-for-approval");
	const connectionInvitation = runtime.getInput("connection-invitation");
	if (connectionInvitation) runtime.addMask(connectionInvitation);
	const client = new ReleaseServiceClient({
		serviceUrl,
		fetch: dependencies.fetch,
		workloadToken: async () => {
			const token = await runtime.getIDToken(serviceUrl);
			runtime.addMask(token);
			return token;
		}
	});
	await runtime.setOutput("connection-url", "");
	let connectionRequestId = null;
	await client.waitForWorkflowConnection({
		publisherDid,
		packageSlug,
		...connectionInvitation ? { invitationToken: connectionInvitation } : {}
	}, {
		idempotencyKey: `github-connection-${runId}-${packageSlug}`,
		pollIntervalMs: pollIntervalSeconds * 1e3,
		maxWaitMs: timeoutMinutes * 6e4,
		onUpdate: async (current) => {
			if (current.status !== "pending" || current.request.id === connectionRequestId) return;
			connectionRequestId = current.request.id;
			await runtime.setOutput("connection-url", current.approvalUrl);
			runtime.info(`Approve this GitHub workflow to continue: ${current.approvalUrl}`);
			await runtime.writeSummary(`## Approve this GitHub workflow\n\n[Open EmDash to review and approve the workflow](${current.approvalUrl})`);
		}
	});
	if (prepared) {
		const packageUpload = await client.uploadReleaseArtifact({
			publisherDid,
			packageSlug,
			version,
			slot: "package",
			checksum: prepared.packageChecksum,
			contentType: "application/gzip",
			bytes: prepared.packageBytes
		}, { idempotencyKey: `github-upload-${runId}-${packageSlug}-package` });
		const provenanceUpload = await client.uploadReleaseArtifact({
			publisherDid,
			packageSlug,
			version,
			slot: "provenance",
			checksum: prepared.provenanceChecksum,
			contentType: "application/json",
			bytes: prepared.provenanceBytes
		}, { idempotencyKey: `github-upload-${runId}-${packageSlug}-provenance` });
		release = sourceReleaseFromPrepared(prepared, packageUpload.artifact.sourceUrl, provenanceUpload.artifact.sourceUrl);
	}
	if (!release) throw new ActionConfigurationError("Release input is unavailable");
	const submitted = await client.submitIntent({
		publisherDid,
		packageSlug,
		version,
		release
	}, { idempotencyKey });
	runtime.info(submitted.replayed ? `Reusing release intent ${submitted.intent.id}` : `Submitted release intent ${submitted.intent.id}`);
	let previousState = submitted.intent.state;
	const intent = await client.waitForIntent(publisherDid, submitted.intent.id, {
		pollIntervalMs: pollIntervalSeconds * 1e3,
		maxWaitMs: timeoutMinutes * 6e4,
		stopOnApproval: !waitForApproval,
		onUpdate: (current) => {
			if (current.state !== previousState) {
				previousState = current.state;
				runtime.info(`Release intent ${current.id} entered ${current.state}`);
			}
		}
	});
	await setIntentOutputs(runtime, intent);
	if (intent.state === "awaiting_approval") {
		runtime.info(`Release intent ${intent.id} requires approval: ${intent.approvalUrl}`);
		return intent;
	}
	if (intent.state === "published" && intent.result) {
		runtime.info(`Published ${intent.result.uri} (${intent.result.cid})`);
		return intent;
	}
	if (FAILURE_STATES.has(intent.state)) throw new ActionConfigurationError(`Release intent ended in ${intent.state}${intent.reasonCode ? ` (${intent.reasonCode})` : ""}`);
	throw new ActionConfigurationError(`Release intent stopped in unexpected state ${intent.state}`);
}
async function executeAction(runtime, dependencies = {}) {
	try {
		await runAction(runtime, dependencies);
	} catch (error) {
		if (error instanceof ReleaseServiceError || error instanceof ActionConfigurationError || error instanceof ReleasePreparationError) {
			runtime.setFailed(error instanceof ReleaseServiceError ? `${error.code}: ${error.message}` : error.message);
			return;
		}
		runtime.setFailed("Delegated release failed");
	}
}

//#endregion
//#region src/runtime.ts
const OUTPUT_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const MAX_OIDC_TOKEN_CHARS = 16 * 1024;
function commandValue(value) {
	return value.replaceAll("%", "%25").replaceAll("\r", "%0D").replaceAll("\n", "%0A");
}
function inputEnvironmentName(name) {
	return `INPUT_${name.replaceAll(" ", "_").toUpperCase()}`;
}
var DefaultActionRuntime = class {
	getInput(name, options = {}) {
		const value = process.env[inputEnvironmentName(name)]?.trim() ?? "";
		if (options.required && value.length === 0) throw new Error(`Required input is missing: ${name}`);
		return value;
	}
	async getIDToken(audience) {
		const requestUrl = process.env["ACTIONS_ID_TOKEN_REQUEST_URL"];
		const requestToken = process.env["ACTIONS_ID_TOKEN_REQUEST_TOKEN"];
		if (!requestUrl || !requestToken) throw new Error("GitHub OIDC is unavailable");
		let url;
		try {
			url = new URL(requestUrl);
			if (url.protocol !== "https:" || url.username !== "" || url.password !== "") throw new Error("invalid OIDC URL");
			url.searchParams.set("audience", audience);
		} catch {
			throw new Error("GitHub OIDC is unavailable");
		}
		const response = await fetch(url, {
			headers: { authorization: `Bearer ${requestToken}` },
			signal: AbortSignal.timeout(3e4)
		});
		if (!response.ok) throw new Error("GitHub OIDC request failed");
		if (response.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json") throw new Error("GitHub OIDC response is invalid");
		let payload;
		try {
			payload = await response.json();
		} catch {
			throw new Error("GitHub OIDC response is invalid");
		}
		if (payload === null || typeof payload !== "object" || Array.isArray(payload) || !("value" in payload) || typeof payload.value !== "string" || payload.value.length === 0 || payload.value.length > MAX_OIDC_TOKEN_CHARS) throw new Error("GitHub OIDC response is invalid");
		return payload.value;
	}
	addMask(value) {
		console.log(`::add-mask::${commandValue(value)}`);
	}
	async setOutput(name, value) {
		if (!OUTPUT_NAME_PATTERN.test(name)) throw new Error("Action output name is invalid");
		const outputFile = process.env["GITHUB_OUTPUT"];
		if (!outputFile) throw new Error("GitHub output file is unavailable");
		const delimiter = `emdash_${crypto.randomUUID()}`;
		await appendFile(outputFile, `${name}<<${delimiter}\n${value}\n${delimiter}\n`, "utf8");
	}
	async writeSummary(markdown) {
		const summaryFile = process.env["GITHUB_STEP_SUMMARY"];
		if (!summaryFile) return;
		await appendFile(summaryFile, `${markdown}\n`, "utf8");
	}
	info(message) {
		console.log(message);
	}
	setFailed(message) {
		console.error(`::error::${commandValue(message)}`);
		process.exitCode = 1;
	}
	getEnvironment(name) {
		return process.env[name];
	}
};

//#endregion
//#region src/index.ts
await executeAction(new DefaultActionRuntime());

//#endregion
export {  };