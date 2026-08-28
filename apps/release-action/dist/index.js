import { appendFile, readFile, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { Buffer } from "node:buffer";

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
//#region ../../node_modules/.pnpm/@atcute+uint8array@1.1.1/node_modules/@atcute/uint8array/dist/index.node.js
const _alloc = Buffer.alloc;
const _allocUnsafe = Buffer.allocUnsafe;
const _concat = Buffer.concat;
const _from = Buffer.from;
const _byteLength = Buffer.byteLength;
const _compare = Buffer.prototype.compare;
const _equals = Buffer.prototype.equals;
const _utf8Slice = Buffer.prototype.utf8Slice;
const _utf8Write = Buffer.prototype.utf8Write;
const _fromCharCode = String.fromCharCode;
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
//#region ../../node_modules/.pnpm/@atcute+lexicons@2.0.0/node_modules/@atcute/lexicons/dist/syntax/uri.js
const URI_RE = /^\w+:(?:\/\/)?[^\s/][^\s]*$/;
const isGenericUri = /* @__NO_SIDE_EFFECTS__ */ (input) => {
	if (typeof input !== "string") return false;
	if (!isUtf8LengthInRange(input, 3, 8192)) return false;
	return URI_RE.test(input);
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
const isObject = /* @__NO_SIDE_EFFECTS__ */ (input) => {
	return typeof input === "object" && input !== null && !isArray(input);
};
const allowsEval = /* @__PURE__ */ lazy(() => {
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
const safeParse = /* @__NO_SIDE_EFFECTS__ */ (schema, input, options) => {
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
const literal = /* @__NO_SIDE_EFFECTS__ */ (value) => {
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
const boolean = /* @__NO_SIDE_EFFECTS__ */ () => {
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
const integer = /* @__NO_SIDE_EFFECTS__ */ () => {
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
const string = /* @__NO_SIDE_EFFECTS__ */ () => {
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
const optional = /* @__NO_SIDE_EFFECTS__ */ (wrapped, defaultValue) => {
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
const array = /* @__NO_SIDE_EFFECTS__ */ (item) => {
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
const object = /* @__NO_SIDE_EFFECTS__ */ (shape) => {
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
			if (allowsEval.value) {
				const fastpass = generateFastpass();
				const matcher = (input, flags) => {
					if (!/* @__PURE__ */ isObject(input)) return ISSUE_TYPE_OBJECT;
					return fastpass(input, flags);
				};
				return /* @__PURE__ */ lazyProperty(this, "~run", matcher);
			}
			const matcher = (input, flags) => {
				if (!/* @__PURE__ */ isObject(input)) return ISSUE_TYPE_OBJECT;
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
const record = /* @__NO_SIDE_EFFECTS__ */ (key, object) => {
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
const unknown = /* @__NO_SIDE_EFFECTS__ */ () => {
	return UNKNOWN_SCHEMA;
};

//#endregion
//#region ../../packages/registry-client/dist/types-Cuqx9ScV.js
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
const DIGITS_PATTERN = /^[0-9]+$/;
const CSRF_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const API_ERROR_CODES = {
	ACCESS_DENIED: true,
	ACCESS_AUTH_INVALID: true,
	ACCESS_AUTH_REQUIRED: true,
	APPROVAL_INVALID: true,
	APPROVER_SESSION_INVALID: true,
	APPROVER_SUSPENDED: true,
	AUTH_INVALID: true,
	CONFIGURATION_ERROR: true,
	CREDENTIAL_LIMIT_REACHED: true,
	CREDENTIAL_NOT_FOUND: true,
	CREDENTIAL_REVOKED: true,
	CSRF_INVALID: true,
	DELEGATION_REQUIRED: true,
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
	PROFILE_CHANGED: true,
	PROFILE_FETCH_FAILED: true,
	PUBLISHER_SESSION_INVALID: true,
	PUBLISHER_SUSPENDED: true,
	RELEASE_EXISTS: true,
	SERVICE_PAUSED: true,
	SERVICE_UNAVAILABLE: true,
	VERSION_RESERVED: true,
	WORKFLOW_UNAVAILABLE: true,
	WORKLOAD_NOT_ALLOWED: true
};
const RETRYABLE_ERROR_CODES = new Set([
	"CONFIGURATION_ERROR",
	"INTERNAL_ERROR",
	"NETWORK_ERROR",
	"PROFILE_FETCH_FAILED",
	"PUBLISHER_SUSPENDED",
	"SERVICE_PAUSED",
	"SERVICE_UNAVAILABLE",
	"WORKFLOW_UNAVAILABLE"
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
	if (!id || !ULID_PATTERN.test(id) || !publisherDid || !DID_PATTERN.test(publisherDid) || !packageSlug || !PACKAGE_SLUG_PATTERN.test(packageSlug) || !version || !VERSION_PATTERN.test(version) || !isIntentState(state) || stateGeneration === null || stateGeneration < 1 || reasonCode === void 0 || workflowId === void 0 || expiresAt === null || createdAt === null || updatedAt === null || result === void 0 || approvalUrl === void 0 || workflowId !== null && !ULID_PATTERN.test(workflowId) || createdAt > updatedAt || updatedAt > expiresAt || result !== null && (result.uri !== `at://${publisherDid}/com.emdashcms.experimental.package.release/${packageSlug}:${version}` || !CID_PATTERN.test(result.cid))) throw invalidResponse();
	if (approvalUrl !== null && serviceUrl) {
		let parsedApproval;
		try {
			parsedApproval = new URL(approvalUrl);
		} catch {
			throw invalidResponse();
		}
		if (parsedApproval.origin !== serviceUrl || parsedApproval.protocol !== "https:") throw invalidResponse();
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
	const delegation = parseDelegation(value["delegation"]);
	const sessionExpiresAt = value["sessionExpiresAt"];
	if (!did || !DID_PATTERN.test(did) || sessionExpiresAt !== void 0 && !Number.isSafeInteger(sessionExpiresAt)) throw invalidResponse();
	return {
		did,
		delegation,
		...sessionExpiresAt === void 0 ? {} : { sessionExpiresAt: Number(sessionExpiresAt) }
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
		const headers = await this.#workloadHeaders(options.idempotencyKey);
		headers.set("content-type", "application/json");
		return await this.call("/v1/release-intents", {
			method: "POST",
			headers,
			body: JSON.stringify(input),
			signal: options.signal
		}, (value) => {
			if (!isRecord(value) || typeof value["replayed"] !== "boolean") throw invalidResponse();
			return {
				intent: parseIntent(value["intent"], this.serviceUrl),
				replayed: value["replayed"]
			};
		});
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
//#region ../../packages/registry-lexicons/dist/generated/types/com/emdashcms/experimental/package/release.js
var release_exports = /* @__PURE__ */ __exportAll({
	artifactSchema: () => artifactSchema,
	artifactsSchema: () => artifactsSchema,
	mainSchema: () => mainSchema,
	sbomSchema: () => sbomSchema
});
const _artifactSchema = /* @__PURE__ */ object({
	$type: /* @__PURE__ */ optional(/* @__PURE__ */ literal("com.emdashcms.experimental.package.release#artifact")),
	checksum: /* @__PURE__ */ constrain(/* @__PURE__ */ string(), [/* @__PURE__ */ stringLength(0, 256)]),
	contentType: /* @__PURE__ */ optional(/* @__PURE__ */ constrain(/* @__PURE__ */ string(), [/* @__PURE__ */ stringLength(0, 256)])),
	height: /* @__PURE__ */ optional(/* @__PURE__ */ constrain(/* @__PURE__ */ integer(), [/* @__PURE__ */ integerRange(1, 8192)])),
	id: /* @__PURE__ */ optional(/* @__PURE__ */ constrain(/* @__PURE__ */ string(), [/* @__PURE__ */ stringLength(0, 128)])),
	lang: /* @__PURE__ */ optional(/* @__PURE__ */ languageCodeString()),
	releaseAsset: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
	requiresAuth: /* @__PURE__ */ optional(/* @__PURE__ */ boolean()),
	signature: /* @__PURE__ */ optional(/* @__PURE__ */ constrain(/* @__PURE__ */ string(), [/* @__PURE__ */ stringLength(0, 1024)])),
	url: /* @__PURE__ */ constrain(/* @__PURE__ */ genericUriString(), [/* @__PURE__ */ stringLength(0, 2048)]),
	width: /* @__PURE__ */ optional(/* @__PURE__ */ constrain(/* @__PURE__ */ integer(), [/* @__PURE__ */ integerRange(1, 8192)]))
});
const _artifactsSchema = /* @__PURE__ */ object({
	$type: /* @__PURE__ */ optional(/* @__PURE__ */ literal("com.emdashcms.experimental.package.release#artifacts")),
	get banner() {
		return /* @__PURE__ */ optional(artifactSchema);
	},
	get icon() {
		return /* @__PURE__ */ optional(artifactSchema);
	},
	get package() {
		return artifactSchema;
	},
	get screenshots() {
		return /* @__PURE__ */ optional(/* @__PURE__ */ constrain(/* @__PURE__ */ array(artifactSchema), [/* @__PURE__ */ arrayLength(0, 8)]));
	}
});
const _mainSchema = /* @__PURE__ */ record(/* @__PURE__ */ string(), /* @__PURE__ */ object({
	$type: /* @__PURE__ */ literal("com.emdashcms.experimental.package.release"),
	get artifacts() {
		return artifactsSchema;
	},
	auth: /* @__PURE__ */ optional(/* @__PURE__ */ unknown()),
	extensions: /* @__PURE__ */ optional(/* @__PURE__ */ unknown()),
	package: /* @__PURE__ */ constrain(/* @__PURE__ */ string(), [/* @__PURE__ */ stringLength(1, 64)]),
	provides: /* @__PURE__ */ optional(/* @__PURE__ */ unknown()),
	repo: /* @__PURE__ */ optional(/* @__PURE__ */ constrain(/* @__PURE__ */ genericUriString(), [/* @__PURE__ */ stringLength(0, 1024)])),
	requires: /* @__PURE__ */ optional(/* @__PURE__ */ unknown()),
	get sbom() {
		return /* @__PURE__ */ optional(sbomSchema);
	},
	suggests: /* @__PURE__ */ optional(/* @__PURE__ */ unknown()),
	version: /* @__PURE__ */ constrain(/* @__PURE__ */ string(), [/* @__PURE__ */ stringLength(1, 64)])
}));
const _sbomSchema = /* @__PURE__ */ object({
	$type: /* @__PURE__ */ optional(/* @__PURE__ */ literal("com.emdashcms.experimental.package.release#sbom")),
	checksum: /* @__PURE__ */ optional(/* @__PURE__ */ constrain(/* @__PURE__ */ string(), [/* @__PURE__ */ stringLength(0, 256)])),
	format: /* @__PURE__ */ optional(/* @__PURE__ */ constrain(/* @__PURE__ */ string(), [/* @__PURE__ */ stringLength(0, 32)])),
	url: /* @__PURE__ */ optional(/* @__PURE__ */ constrain(/* @__PURE__ */ genericUriString(), [/* @__PURE__ */ stringLength(0, 2048)]))
});
const artifactSchema = _artifactSchema;
const artifactsSchema = _artifactsSchema;
const mainSchema = _mainSchema;
const sbomSchema = _sbomSchema;

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
const DELEGATED_RELEASE_PERMISSION = Object.freeze({
	collection: NSID.packageRelease,
	scope: `atproto repo:${NSID.packageRelease}?action=create`
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
async function runAction(runtime, dependencies = {}) {
	const serviceUrl = runtime.getInput("service-url", { required: true });
	const publisherDid = runtime.getInput("publisher-did", { required: true });
	if (!/* @__PURE__ */ isDid(publisherDid)) throw new ActionConfigurationError("publisher-did must be a valid DID");
	const releaseFile = runtime.getInput("release-file", { required: true });
	const workspace = runtime.getEnvironment("GITHUB_WORKSPACE");
	if (!workspace) throw new ActionConfigurationError("GitHub workspace is unavailable");
	const rawRelease = await (dependencies.readReleaseRecord ?? defaultReadReleaseRecord)(releaseFile, workspace);
	const release = /* @__PURE__ */ safeParse(release_exports.mainSchema, rawRelease);
	if (!release.ok) throw new ActionConfigurationError("Release record file is invalid");
	const idempotencyKey = runtime.getInput("idempotency-key") || defaultIdempotencyKey(runtime);
	const pollIntervalSeconds = parsePositiveInteger(runtime.getInput("poll-interval-seconds") || "5", "poll-interval-seconds", 300);
	const timeoutMinutes = parsePositiveInteger(runtime.getInput("timeout-minutes") || "30", "timeout-minutes", 360);
	const waitForApproval = parseBoolean(runtime.getInput("wait-for-approval") || "false", "wait-for-approval");
	const client = new ReleaseServiceClient({
		serviceUrl,
		fetch: dependencies.fetch,
		workloadToken: async () => {
			const token = await runtime.getIDToken(serviceUrl);
			runtime.addMask(token);
			return token;
		}
	});
	const submitted = await client.submitIntent({
		publisherDid,
		packageSlug: release.value.package,
		version: release.value.version,
		release: release.value
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
		if (error instanceof ReleaseServiceError || error instanceof ActionConfigurationError) {
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