/**
 * Read and validate an `emdash-plugin.jsonc` manifest from disk.
 *
 * Failure modes, each with a distinct error code for scriptable consumers
 * (`validate --json`, programmatic API users):
 *
 *   - `MANIFEST_NOT_FOUND` — file doesn't exist at the resolved path.
 *   - `MANIFEST_TOO_LARGE` — file exceeds `MANIFEST_MAX_BYTES`. Reading
 *     stops at the cap; the file is never fully buffered.
 *   - `MANIFEST_PARSE_ERROR` — JSONC parse failure (trailing comma, missing
 *     bracket, control char in string, duplicate keys). Includes line +
 *     column from `jsonc-parser`'s offset.
 *   - `MANIFEST_VALIDATION_ERROR` — JSONC parsed cleanly but the value
 *     failed the Zod schema. Includes the field path and the offending
 *     value's location in the source where possible.
 *
 * The line/column mapping is critical for editor-side workflows: a user
 * running `emdash-registry validate` from a CI step wants the same kind of
 * pointer they'd get from `tsc` or `eslint`, not a Zod issue tree.
 */

import { open } from "node:fs/promises";
import { resolve } from "node:path";

import { parseTree, type Node, type ParseError, printParseErrorCode } from "jsonc-parser";
import type { ZodIssue } from "zod";

import { ManifestSchema, type Manifest } from "./schema.js";

/**
 * Conventional manifest filename. Lives next to the plugin's `package.json`.
 */
export const MANIFEST_FILENAME = "emdash-plugin.jsonc";

/**
 * Hard cap on the bytes we'll buffer for a manifest. The largest real-world
 * v1 manifest under the current schema is a few hundred bytes; even a heavily-
 * populated future version with all the long-form sections from issue #1030
 * (5 sections × 20 KB cap each from the lexicon) tops out under 128 KB. We
 * pick 1 MiB so accidental mis-targets (`--manifest ./large.tar`) fail fast
 * with a clear error rather than OOMing the CLI.
 */
export const MANIFEST_MAX_BYTES = 1024 * 1024;

export type ManifestErrorCode =
	| "MANIFEST_NOT_FOUND"
	| "MANIFEST_TOO_LARGE"
	| "MANIFEST_PARSE_ERROR"
	| "MANIFEST_VALIDATION_ERROR";

export class ManifestError extends Error {
	override readonly name = "ManifestError";
	readonly code: ManifestErrorCode;
	/** Resolved absolute path of the manifest file. */
	readonly path: string;
	/**
	 * Issues for `MANIFEST_VALIDATION_ERROR`. One per failed rule, each
	 * carrying a JSON pointer-style path and an optional source location.
	 * Empty for the other error codes.
	 */
	readonly issues: ManifestIssue[];

	constructor(
		code: ManifestErrorCode,
		message: string,
		path: string,
		issues: ManifestIssue[] = [],
	) {
		super(message);
		this.code = code;
		this.path = path;
		this.issues = issues;
	}
}

export interface ManifestIssue {
	/** Dotted/bracketed JSON path, e.g. `authors[0].email`. */
	path: string;
	message: string;
	/** 1-indexed line and column in the manifest source, when known. */
	location?: { line: number; column: number };
}

export interface LoadManifestResult {
	manifest: Manifest;
	/** Resolved absolute path. */
	path: string;
}

/**
 * Load and validate a manifest at `path`. `path` may be a directory (in
 * which case `emdash-plugin.jsonc` is appended) or a file.
 *
 * Throws `ManifestError` on every failure path. Successful return guarantees
 * the manifest is schema-valid (but normalisation to the publish-input
 * shape still needs `./translate.ts`).
 */
export async function loadManifest(path: string): Promise<LoadManifestResult> {
	const resolved = resolve(path);
	// Heuristic: paths that end in `.jsonc` or `.json` are treated as
	// files; everything else is treated as a directory. We don't `stat`
	// to disambiguate because the error path "missing file" should be the
	// same regardless of which form the caller passed.
	const filePath =
		resolved.endsWith(".jsonc") || resolved.endsWith(".json")
			? resolved
			: resolve(resolved, MANIFEST_FILENAME);

	// Bounded read: open the file and read at most MANIFEST_MAX_BYTES+1
	// bytes. The extra byte is a sentinel — if we get it, the file is
	// definitely over the cap regardless of what `stat` would say.
	// This closes the stat-then-readFile race where a concurrent writer
	// could grow the file between size check and buffer.
	const source = await readBoundedUtf8(filePath);
	return parseAndValidate(source, filePath);
}

/**
 * Read a UTF-8 file with a hard cap of `MANIFEST_MAX_BYTES` bytes.
 * Throws `ManifestError(MANIFEST_TOO_LARGE)` if the file exceeds the cap,
 * `ManifestError(MANIFEST_NOT_FOUND)` for ENOENT.
 *
 * We allocate a buffer of `MANIFEST_MAX_BYTES + 1` and read into it; if
 * the read fills the whole buffer, the file is at least one byte over
 * the limit and we reject. This avoids the TOCTOU window of a separate
 * `stat` call: a concurrent writer can grow the file between syscalls,
 * but it can never make our buffer larger than what we allocated up
 * front.
 *
 * `read` returns a single chunk synchronously from kernel buffers when
 * available; for files of our cap size (1 MiB) this is one syscall on
 * Linux/macOS. We loop in case the kernel returns a short read.
 */
async function readBoundedUtf8(filePath: string): Promise<string> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(filePath, "r");
	} catch (error) {
		if (isNodeNotFoundError(error)) {
			throw new ManifestError(
				"MANIFEST_NOT_FOUND",
				`No manifest at ${filePath}. Create one with: emdash-registry init`,
				filePath,
			);
		}
		throw error;
	}
	try {
		// One extra byte so we can detect oversize without reading
		// arbitrarily much.
		const buffer = Buffer.allocUnsafe(MANIFEST_MAX_BYTES + 1);
		let totalRead = 0;
		while (totalRead < buffer.length) {
			const { bytesRead } = await handle.read(
				buffer,
				totalRead,
				buffer.length - totalRead,
				totalRead,
			);
			if (bytesRead === 0) break;
			totalRead += bytesRead;
		}
		if (totalRead > MANIFEST_MAX_BYTES) {
			throw new ManifestError(
				"MANIFEST_TOO_LARGE",
				`Manifest at ${filePath} is larger than the ${MANIFEST_MAX_BYTES}-byte cap. Check that you pointed --manifest at the right file.`,
				filePath,
			);
		}
		return buffer.subarray(0, totalRead).toString("utf8");
	} finally {
		await handle.close().catch(() => {
			// Closing a handle should never fail in practice; if it
			// does, swallow it — the read result is already in hand.
		});
	}
}

/**
 * Variant for callers that already have the source text in hand (tests,
 * editor integrations that read the buffer). The `path` argument is used
 * for error messages only.
 */
export function parseAndValidateManifest(source: string, path: string): LoadManifestResult {
	return parseAndValidate(source, path);
}

// ──────────────────────────────────────────────────────────────────────────
// Internals
// ──────────────────────────────────────────────────────────────────────────

function parseAndValidate(source: string, filePath: string): LoadManifestResult {
	const parseErrors: ParseError[] = [];
	// `parseTree` gives us both the parsed value AND the syntax tree, so we
	// can map a Zod issue's path back to a source offset. `parse` alone
	// loses that information.
	const root = parseTree(source, parseErrors, {
		// Comments are part of the JSONC contract. Trailing commas are
		// allowed because they reduce diff noise when the user adds a new
		// field at the end.
		disallowComments: false,
		allowTrailingComma: true,
		allowEmptyContent: false,
	});

	if (parseErrors.length > 0) {
		const first = parseErrors[0]!;
		const { line, column } = offsetToLineCol(source, first.offset);
		throw new ManifestError(
			"MANIFEST_PARSE_ERROR",
			`${filePath}:${line}:${column}: ${printParseErrorCode(first.error)}`,
			filePath,
		);
	}

	if (!root) {
		// Shouldn't be reachable when `allowEmptyContent: false` is set and
		// `parseErrors` is empty, but `parseTree`'s return type is nullable.
		throw new ManifestError("MANIFEST_PARSE_ERROR", `${filePath}: file is empty`, filePath);
	}

	// Reject duplicate keys before validation. `nodeToValue` is last-wins
	// (matches JSON.parse semantics) which silently shadows earlier keys
	// — review-hostile for a security-sensitive document like this. We
	// scan once for duplicates and surface them as a parse error with a
	// source location, so a `git diff` reviewer can't be fooled by a
	// "publisher": "<honest>" at the top of the file that gets overridden
	// by "publisher": "<hostile>" further down.
	const duplicate = findDuplicateKey(root);
	if (duplicate) {
		const { line, column } = offsetToLineCol(source, duplicate.offset);
		throw new ManifestError(
			"MANIFEST_PARSE_ERROR",
			`${filePath}:${line}:${column}: duplicate key "${duplicate.key}". Each property may only be declared once.`,
			filePath,
		);
	}

	const value = nodeToValue(root);

	const result = ManifestSchema.safeParse(value);
	if (!result.success) {
		const issues = result.error.issues.map((issue) => zodIssueToManifestIssue(issue, source, root));
		const summary = issues
			.map((i) => {
				const loc = i.location ? `:${i.location.line}:${i.location.column}` : "";
				return `${filePath}${loc}: ${i.path ? `${i.path}: ` : ""}${i.message}`;
			})
			.join("\n");
		throw new ManifestError(
			"MANIFEST_VALIDATION_ERROR",
			`Manifest validation failed:\n${summary}`,
			filePath,
			issues,
		);
	}

	return { manifest: result.data, path: filePath };
}

/**
 * Map a Zod issue to a manifest issue. The path translation strips the
 * leading `$` that some Zod versions prepend and produces the JSONC-style
 * `authors[0].email` syntax users will recognise.
 *
 * Zod 4 types path segments as `PropertyKey` (string | number | symbol).
 * Symbols cannot appear in a JSON-parsed value's path (JSON has no symbol
 * keys), so we narrow defensively and treat any stray symbol as an
 * opaque "<symbol>" string in the displayed path.
 *
 * Special-cases `unrecognized_keys` (typo'd field names): Zod reports the
 * issue at the parent path with the offending key(s) in `issue.keys`.
 * Without special handling, the line:col points at the parent object's
 * opening brace, not the actual typo. We resolve the first listed key
 * inside the parent and use ITS source offset, so a `"licens": "MIT"`
 * mistake gets the pointer landing on the bad key's line and column.
 */
function zodIssueToManifestIssue(issue: ZodIssue, source: string, root: Node): ManifestIssue {
	const path = narrowZodPath(issue.path);
	const pathStr = formatZodPath(path);

	let offset: number | undefined;
	if (issue.code === "unrecognized_keys") {
		const keys = (issue as ZodIssue & { keys?: readonly string[] }).keys;
		const firstKey = keys?.[0];
		if (firstKey !== undefined) {
			const parent = findNodeAtPath(root, path);
			if (parent?.type === "object" && parent.children) {
				const prop: Node | undefined = parent.children.find(
					(c) =>
						c.type === "property" &&
						c.children?.[0]?.type === "string" &&
						c.children[0].value === firstKey,
				);
				const keyNode = prop?.children?.[0];
				if (keyNode) offset = keyNode.offset;
			}
		}
	}
	if (offset === undefined) {
		offset = findNodeAtPath(root, path)?.offset;
	}

	const location = offset !== undefined ? offsetToLineCol(source, offset) : undefined;
	return location
		? { path: pathStr, message: issue.message, location }
		: { path: pathStr, message: issue.message };
}

/**
 * Coerce a Zod 4 issue path (`PropertyKey[]`) to the string|number form
 * the rest of the loader uses. A symbol segment is impossible for JSONC
 * input, but we render it defensively rather than crashing.
 */
function narrowZodPath(path: ReadonlyArray<PropertyKey>): Array<string | number> {
	return path.map((segment) => {
		if (typeof segment === "string" || typeof segment === "number") return segment;
		return segment.toString();
	});
}

/**
 * Format a Zod path array as `authors[0].email`. Numbers become bracketed
 * indices; strings become dot-prefixed (except the first).
 */
function formatZodPath(path: ReadonlyArray<string | number>): string {
	let out = "";
	for (const segment of path) {
		if (typeof segment === "number") {
			out += `[${segment}]`;
		} else {
			out += out.length === 0 ? segment : `.${segment}`;
		}
	}
	return out;
}

/**
 * Walk the JSONC syntax tree to find the node at a given path. When the
 * path traverses into a missing key or a wrong-shape value, returns the
 * deepest ancestor that DID exist — so the resulting line:col still
 * points at something useful (the parent object, where the missing
 * property "should have been"). This matters most for two error
 * classes:
 *
 *   - Missing required key: Zod's path is `[key]`, the value doesn't
 *     exist; returning the root object's offset puts the pointer at the
 *     opening brace, which an editor highlights as "issue with this
 *     object".
 *   - Unknown key (typo): Zod's path is `[wrongKey]`, the value doesn't
 *     exist in the parent. Same parent-fallback gives the pointer the
 *     line of the parent object.
 *
 * Both cases used to return undefined and lose the line:col entirely.
 */
function findNodeAtPath(root: Node, path: ReadonlyArray<string | number>): Node | undefined {
	let current: Node | undefined = root;
	let lastResolved: Node | undefined = root;
	for (const segment of path) {
		if (!current) return lastResolved;
		if (typeof segment === "number") {
			if (current.type !== "array" || !current.children) return current;
			const next: Node | undefined = current.children[segment];
			if (!next) return current;
			current = next;
		} else {
			if (current.type !== "object" || !current.children) return current;
			const prop: Node | undefined = current.children.find(
				(c) =>
					c.type === "property" &&
					c.children?.[0]?.type === "string" &&
					c.children[0].value === segment,
			);
			// `property` node's children are [keyNode, valueNode]. We want
			// the value for further traversal. If the property is missing
			// entirely (e.g. typo'd key, missing required field), fall
			// back to the current object so the caller gets a source
			// location for the containing structure.
			const next: Node | undefined = prop?.children?.[1];
			if (!next) return current;
			current = next;
		}
		lastResolved = current;
	}
	return current;
}

/**
 * Recursively scan an object node for duplicate property names. Returns
 * the FIRST duplicate found (innermost-first within the recursion, but
 * order across siblings is the order in the source) with its offset for
 * line:column reporting.
 *
 * We scan the entire tree, not just the root: duplicate keys inside
 * `author: { ... }` or `security: { ... }` are equally review-hostile.
 */
function findDuplicateKey(node: Node): { key: string; offset: number } | undefined {
	if (node.type === "object" && node.children) {
		const seen = new Set<string>();
		for (const prop of node.children) {
			if (prop.type !== "property") continue;
			const keyNode = prop.children?.[0];
			if (!keyNode || keyNode.type !== "string" || typeof keyNode.value !== "string") {
				continue;
			}
			if (seen.has(keyNode.value)) {
				return { key: keyNode.value, offset: keyNode.offset };
			}
			seen.add(keyNode.value);
			const valueNode = prop.children?.[1];
			if (valueNode) {
				const nested = findDuplicateKey(valueNode);
				if (nested) return nested;
			}
		}
	} else if (node.type === "array" && node.children) {
		for (const child of node.children) {
			const nested = findDuplicateKey(child);
			if (nested) return nested;
		}
	}
	return undefined;
}

/**
 * Convert a JSONC syntax-tree node to its plain JavaScript value. The
 * `parseTree` API doesn't return values directly; this walks the tree.
 *
 * We can't use `jsonc-parser`'s `parse()` (which would give us the value
 * directly) because we need the tree anyway for error-location mapping,
 * and parsing twice doubles the work for a file we're about to validate.
 */
function nodeToValue(node: Node): unknown {
	switch (node.type) {
		case "object": {
			const obj: Record<string, unknown> = {};
			for (const prop of node.children ?? []) {
				if (prop.type !== "property") continue;
				const [keyNode, valueNode] = prop.children ?? [];
				if (!keyNode || keyNode.type !== "string" || !valueNode) continue;
				if (typeof keyNode.value !== "string") continue;
				obj[keyNode.value] = nodeToValue(valueNode);
			}
			return obj;
		}
		case "array":
			return (node.children ?? []).map((child) => nodeToValue(child));
		case "string":
		case "number":
		case "boolean":
		case "null":
			return node.value;
		default:
			return undefined;
	}
}

/**
 * Convert a byte offset in `source` into 1-indexed line + column. Matches
 * the convention `tsc` and `eslint` use for error pointers.
 */
function offsetToLineCol(source: string, offset: number): { line: number; column: number } {
	let line = 1;
	let column = 1;
	const max = Math.min(offset, source.length);
	for (let i = 0; i < max; i++) {
		if (source.charCodeAt(i) === 10 /* \n */) {
			line++;
			column = 1;
		} else {
			column++;
		}
	}
	return { line, column };
}

function isNodeNotFoundError(error: unknown): boolean {
	return (
		error instanceof Error && "code" in error && (error as { code: unknown }).code === "ENOENT"
	);
}
