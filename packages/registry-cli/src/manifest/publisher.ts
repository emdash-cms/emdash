/**
 * Verify that the active session matches the manifest's pinned `publisher`,
 * and write the publisher back to the manifest on first publish.
 *
 * Two paths, depending on the manifest state at publish time:
 *
 *   1. Manifest pins a publisher (DID or handle).
 *      - DID: compare verbatim against the session DID. Mismatch is an
 *        immediate, no-override error. The user must `emdash-registry switch`
 *        to the right session, or edit the manifest if they're transferring
 *        the plugin.
 *      - Handle: resolve to a DID via `@atcute/identity-resolver`, then
 *        compare. Resolution failures surface as a distinct error code so
 *        the user can tell "wrong handle" from "wrong account".
 *   2. Manifest omits `publisher`.
 *      - Publish proceeds with the active session.
 *      - On success, the CLI writes `"publisher": "<session-did>"` back
 *        to the manifest file using `jsonc-parser`'s `modify` + `applyEdits`
 *        so comments and formatting are preserved.
 *
 * The write-back is a post-publish convenience: failures here MUST NOT
 * roll back or fail the publish. The publish has already committed to the
 * publisher's PDS by this point.
 *
 * The DID-only write-back rule (we never write a handle) is documented
 * in #1028. Hand-written handles are respected verbatim; the user can
 * still pin a handle if they prefer the readability.
 */

import { createHash, randomUUID } from "node:crypto";
import { open, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isDid, isHandle, type Did, type Handle } from "@atcute/lexicons/syntax";
import { applyEdits, modify, parseTree, printParseErrorCode, type ParseError } from "jsonc-parser";

import { createActorResolver } from "../oauth.js";
import { MANIFEST_MAX_BYTES } from "./load.js";

/**
 * Result of comparing a manifest's pinned publisher against the active
 * session DID. The shape encodes the three downstream cases:
 *
 *   - `match`: publisher pinned, resolved to the session DID. Publish
 *     proceeds; no write-back.
 *   - `unpinned`: publisher omitted. Publish proceeds; write-back
 *     scheduled for after the successful publish.
 *   - `mismatch`: publisher pinned but doesn't resolve to the session DID.
 *     Publish refuses; the caller throws.
 */
export type PublisherCheck =
	| { kind: "match"; pinnedDid: Did }
	| { kind: "unpinned" }
	| { kind: "mismatch"; pinnedDid: Did; pinnedDisplay: string };

export type PublisherCheckErrorCode = "MANIFEST_PUBLISHER_UNRESOLVED";

export class PublisherCheckError extends Error {
	override readonly name = "PublisherCheckError";
	readonly code: PublisherCheckErrorCode;
	constructor(code: PublisherCheckErrorCode, message: string) {
		super(message);
		this.code = code;
	}
}

/**
 * Compare a manifest's `publisher` value (if any) against the active
 * session's DID. Returns a structured outcome rather than throwing on
 * mismatch — the caller decides how to render the error so the CLI's
 * human + JSON output paths can format consistently.
 *
 * Throws `PublisherCheckError` only for *failures of the check itself*
 * (e.g. the handle couldn't be resolved to a DID). Logical mismatch is
 * a successful check result with `kind: "mismatch"`.
 */
export async function checkPublisher(input: {
	manifestPublisher: string | undefined;
	sessionDid: Did;
}): Promise<PublisherCheck> {
	if (input.manifestPublisher === undefined) {
		return { kind: "unpinned" };
	}

	const pinned = input.manifestPublisher;

	if (isDid(pinned)) {
		if (pinned === input.sessionDid) {
			return { kind: "match", pinnedDid: pinned };
		}
		return { kind: "mismatch", pinnedDid: pinned, pinnedDisplay: pinned };
	}

	if (isHandle(pinned)) {
		const resolved = await resolveHandleToDid(pinned);
		if (resolved === input.sessionDid) {
			return { kind: "match", pinnedDid: resolved };
		}
		return { kind: "mismatch", pinnedDid: resolved, pinnedDisplay: pinned };
	}

	// Should be unreachable: the schema validates the syntax, so an
	// invalid value can only reach here when the caller bypassed
	// validation. We surface a generic resolver error rather than
	// crashing, so the failure path stays consistent.
	throw new PublisherCheckError(
		"MANIFEST_PUBLISHER_UNRESOLVED",
		`publisher value "${pinned}" is neither a DID nor a handle. Edit the manifest to use a valid DID or handle.`,
	);
}

/**
 * Resolve an atproto handle to a DID via the same actor-resolver the
 * OAuth flow uses (DoH + .well-known). Surfaces resolution failures
 * with a clear hint pointing the user at the DID-pin escape hatch.
 */
async function resolveHandleToDid(handle: Handle): Promise<Did> {
	const resolver = createActorResolver();
	try {
		const resolved = await resolver.resolve(handle);
		return resolved.did;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new PublisherCheckError(
			"MANIFEST_PUBLISHER_UNRESOLVED",
			`could not resolve handle "${handle}" to a DID: ${reason}. ` +
				`To avoid the lookup, replace the handle with the DID directly in the manifest (publisher: "did:plc:...").`,
		);
	}
}

/**
 * Write the session DID back to the manifest as the `publisher` field,
 * inserting it right after `license` to give a stable canonical order.
 *
 * The DID is the value the CLI compares against on subsequent publishes;
 * the handle (when provided) is appended as a JSONC line comment for
 * human readability of `git diff` output. The CLI ignores the comment
 * — handle changes don't break the pin, only DID changes do.
 *
 * Re-reads the source from disk first and re-parses to detect concurrent
 * edits. If the file changed (publisher already set, parse errors, or
 * the file is gone), the write-back is skipped with a warning rather
 * than overwriting the user's edits.
 *
 * Errors are caught and surfaced as warnings to `onWarn`. The publish
 * has already succeeded by the time this runs; a failed write-back must
 * not fail the publish.
 */
export async function writePublisherBack(input: {
	manifestPath: string;
	sessionDid: Did;
	/**
	 * Optional handle of the active session, rendered as a line comment
	 * next to the inserted DID. The comment is purely informational; the
	 * CLI never reads it back. Omit for sessions that have no handle
	 * (e.g. did-only logins).
	 */
	sessionHandle?: string;
	onInfo?: (message: string) => void;
	onWarn?: (message: string) => void;
}): Promise<void> {
	const { manifestPath, sessionDid, sessionHandle, onInfo, onWarn } = input;
	try {
		// Bounded read with the same cap the loader uses. If the file
		// ballooned between load and write-back (e.g. the user pasted
		// in a huge changelog while we were publishing), abort the
		// write-back rather than buffering the new contents — the
		// post-publish path should never touch a file the loader
		// wouldn't have accepted.
		const initial = await readManifestBounded(manifestPath);
		if (initial.kind === "oversize") {
			onWarn?.(
				`Skipped writing publisher to ${manifestPath} (file is now larger than the ${MANIFEST_MAX_BYTES}-byte cap; the publish succeeded).`,
			);
			return;
		}
		if (initial.kind === "missing") {
			onWarn?.(
				`Skipped writing publisher to ${manifestPath} (file was removed during publish; the publish succeeded).`,
			);
			return;
		}
		const source = initial.source;

		// Defensive re-parse: confirm `publisher` is still absent. If
		// the user added one while we were publishing, leave their value
		// alone. Same if the file no longer parses cleanly. `parseTree`
		// is lenient and returns a partial tree on malformed input, so
		// we have to inspect the errors array — checking the root's
		// type alone misses things like "missing closing brace".
		const parseErrors: ParseError[] = [];
		const root = parseTree(source, parseErrors, {
			disallowComments: false,
			allowTrailingComma: true,
			allowEmptyContent: false,
		});
		if (parseErrors.length > 0) {
			const first = parseErrors[0]!;
			onWarn?.(
				`Skipped writing publisher to ${manifestPath} (file no longer parses: ${printParseErrorCode(first.error)}).`,
			);
			return;
		}
		if (!root || root.type !== "object") {
			onWarn?.(
				`Skipped writing publisher to ${manifestPath} (file no longer parses as a JSONC object).`,
			);
			return;
		}
		const hasPublisher = root.children?.some(
			(prop) =>
				prop.type === "property" &&
				prop.children?.[0]?.type === "string" &&
				prop.children[0].value === "publisher",
		);
		if (hasPublisher) {
			onInfo?.(`Skipped writing publisher to ${manifestPath} (already set by user).`);
			return;
		}

		// `modify` returns a list of text edits; `applyEdits` resolves
		// them against the source. This is the JSONC-aware path that
		// preserves comments and existing whitespace.
		//
		// Indentation is sniffed from the user's existing source rather
		// than hard-coded. Without this, a 2-space-indented manifest
		// gets silently rewritten to tabs on first publish — a
		// surprising behaviour for a write-back that's supposed to be
		// a small, targeted edit. `getInsertionIndex` places `publisher`
		// immediately after `license` (or at the end of the object if
		// `license` isn't present, which shouldn't happen for a
		// schema-valid manifest but is handled defensively).
		const indent = detectIndent(source);
		const edits = modify(source, ["publisher"], sessionDid, {
			formattingOptions: { insertSpaces: !indent.useTabs, tabSize: indent.size },
			getInsertionIndex: (existingProps) => {
				const licenseIdx = existingProps.indexOf("license");
				if (licenseIdx >= 0) return licenseIdx + 1;
				return existingProps.length;
			},
		});
		if (edits.length === 0) {
			onWarn?.(
				`Skipped writing publisher to ${manifestPath} (no edits produced; file may be malformed).`,
			);
			return;
		}
		const applied = applyEdits(source, edits);

		// Append a `// <handle>` line comment to the inserted publisher
		// line, if we have a handle. The comment is for human readers of
		// `git diff`; the CLI itself never parses it back out. We locate
		// the inserted line by re-parsing the updated source and looking
		// up the `publisher` property node's exact source offset, so a
		// DID string that happens to appear elsewhere in the document
		// (e.g. in `description`) can't deflect the comment to the
		// wrong line.
		const updated = sessionHandle ? annotatePublisherLine(applied, sessionHandle) : applied;

		// Atomic write: tmpfile + rename. POSIX rename is atomic, so a
		// crash mid-write leaves the previous file intact rather than
		// truncating the publisher's manifest.
		//
		// TOCTOU narrowing: re-read the file IMMEDIATELY before rename
		// and compare to the bytes we processed. If anything changed
		// (editor save, concurrent publish, manual edit), abort the
		// write-back. This doesn't eliminate the race — between the
		// final read and the rename a writer could still land — but
		// it shrinks the window to milliseconds. The publish has
		// already succeeded; losing a convenience pin is preferable
		// to overwriting a user's edit.
		const expectedHash = sha256(source);
		const tmp = join(dirname(manifestPath), `.${randomUUID()}.tmp`);
		await writeFile(tmp, updated, "utf8");
		// Re-read with the same bounded primitive so a file that grew
		// past the cap during publish doesn't OOM the verification step.
		// Oversize and missing both indicate the file is no longer the
		// bytes we hashed; treat them as drift and bail.
		//
		// Wrap in try/catch so genuinely-unexpected fs failures here
		// (EISDIR if the file was replaced with a directory, EACCES,
		// etc.) ALSO route through the drift-cleanup path. Otherwise
		// the tmpfile we just wrote would leak into the manifest's
		// directory because the outer catch handles the failure but
		// doesn't know there's a tmpfile to clean up.
		let currentHash: string | null;
		try {
			const current = await readManifestBounded(manifestPath);
			currentHash = current.kind === "ok" ? sha256(current.source) : null;
		} catch {
			currentHash = null;
		}
		if (currentHash !== expectedHash) {
			// File changed under us. Clean up the tmpfile and bail.
			await unlinkIgnoreMissing(tmp);
			onWarn?.(
				`Skipped writing publisher to ${manifestPath} (file changed during publish; no edits made). The publish succeeded; you can pin manually on your next edit.`,
			);
			return;
		}
		await rename(tmp, manifestPath);
		onInfo?.(`Pinned publisher to ${sessionDid} in ${manifestPath}.`);
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		onWarn?.(
			`Could not pin publisher to ${manifestPath}: ${reason}. ` +
				`The publish succeeded; you can add publisher manually on your next edit.`,
		);
	}
}

/**
 * Discriminated result of a bounded manifest read.
 */
type BoundedReadResult =
	| { kind: "ok"; source: string }
	| { kind: "oversize" }
	| { kind: "missing" };

/**
 * Read a manifest with a hard size cap. Returns a discriminated result:
 *   - `ok` carrying the UTF-8 contents,
 *   - `oversize` when the file exceeds `MANIFEST_MAX_BYTES`,
 *   - `missing` for ENOENT.
 *
 * Bounded variant of the loader's read; same TOCTOU-free pattern (one
 * pre-allocated buffer, never grows). We use a discriminated union
 * rather than sentinel strings so the type system catches a caller
 * that forgets to handle the failure cases.
 */
async function readManifestBounded(filePath: string): Promise<BoundedReadResult> {
	let handle: Awaited<ReturnType<typeof open>>;
	try {
		handle = await open(filePath, "r");
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as { code: unknown }).code === "ENOENT"
		) {
			return { kind: "missing" };
		}
		throw error;
	}
	try {
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
		if (totalRead > MANIFEST_MAX_BYTES) return { kind: "oversize" };
		return { kind: "ok", source: buffer.subarray(0, totalRead).toString("utf8") };
	} finally {
		await handle.close().catch(() => {});
	}
}

/**
 * Sniff the indentation style used by the source so the write-back can
 * match it. Looks at the first indented line and reports whether the
 * leading whitespace is tabs or spaces, and the run length.
 *
 * Falls back to tabs-with-tabSize-1 when:
 *   - no indented line is found (single-line manifest), or
 *   - the file is unreadable in a way we can't infer from.
 *
 * The tab-fallback matches the conventions of the repo's own JSONC files
 * (wrangler.jsonc, tsconfig.json, this very package's templates).
 */
function detectIndent(source: string): { useTabs: boolean; size: number } {
	const lines = source.split("\n");
	for (const line of lines) {
		if (line.length === 0) continue;
		const first = line[0];
		if (first === "\t") return { useTabs: true, size: 1 };
		if (first === " ") {
			let count = 0;
			while (count < line.length && line[count] === " ") count++;
			// Indent runs of 1 are weird; round up to 2 as the most
			// common non-tab indent. Anything 2-8 we use verbatim.
			return { useTabs: false, size: Math.max(2, Math.min(count, 8)) };
		}
		// Non-whitespace first char → this line isn't indented; keep looking.
	}
	return { useTabs: true, size: 1 };
}

/** Compute a stable hash of the source bytes, used for TOCTOU narrowing. */
function sha256(source: string): string {
	return createHash("sha256").update(source, "utf8").digest("hex");
}

/**
 * Remove a file path, treating ENOENT as success. Used to clean up the
 * tmpfile when the write-back is aborted post-write but pre-rename.
 */
async function unlinkIgnoreMissing(path: string): Promise<void> {
	const { unlink } = await import("node:fs/promises");
	try {
		await unlink(path);
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error as { code: unknown }).code === "ENOENT"
		) {
			return;
		}
		// Anything else is also non-fatal here (the tmpfile is best-
		// effort cleanup); we swallow it so the outer warn message
		// stays the dominant signal.
	}
}

/**
 * Append `// <handle>` to the line containing the inserted `publisher`
 * property's value.
 *
 * The implementation re-parses the updated source, locates the
 * `publisher` property's value node by name (NOT by string-matching the
 * DID), and uses that node's source offset as the anchor. Two reasons
 * for the re-parse rather than a raw string search:
 *
 *   1. A DID string can legitimately appear elsewhere in the manifest
 *      (e.g. as the value of `description` or a custom comment-like
 *      field). String search would attach the comment to the first
 *      occurrence, not the inserted property.
 *   2. The parse tree gives us byte-exact offsets, so the line-end
 *      lookup can't degrade silently when `indexOf` returns -1.
 *
 * If the `publisher` property can't be located (unexpected — we just
 * inserted it), returns the input unchanged. Annotation is a nice-to-
 * have; the publish has already succeeded.
 *
 * No sanitisation of the handle is needed: `session.handle` is
 * populated by atproto's identity resolver at login time, which only
 * accepts values that (a) match the handle syntax (no control chars,
 * no `/`, no `*`, no whitespace) and (b) round-trip via DoH or
 * `.well-known` to the session DID. An attacker who can put arbitrary
 * bytes into `session.handle` already controls the user's identity.
 */
function annotatePublisherLine(source: string, handle: string): string {
	if (handle.length === 0) return source;

	const tree = parseTree(source);
	if (!tree || tree.type !== "object") return source;
	const publisherProp = tree.children?.find(
		(prop) =>
			prop.type === "property" &&
			prop.children?.[0]?.type === "string" &&
			prop.children[0].value === "publisher",
	);
	const valueNode = publisherProp?.children?.[1];
	if (!valueNode) return source;

	// Find the end of the line containing the value's last byte. The
	// value's offset+length lands right after the closing `"` of the
	// DID string; `indexOf("\n", endOfValue)` walks forward to the
	// newline that terminates the property's line. The intervening
	// bytes can be `,`, whitespace, or already-existing comment text.
	const endOfValue = valueNode.offset + valueNode.length;
	const lineEnd = source.indexOf("\n", endOfValue);
	if (lineEnd < 0) {
		// `publisher` is on the last line of the file with no trailing
		// newline. Append the comment to the end-of-file content.
		return `${source} // ${handle}`;
	}
	// Walk back past any trailing CR so the comment lands at the end
	// of the *content*, not after a literal "\r" on Windows-authored
	// files.
	let insertAt = lineEnd;
	if (insertAt > 0 && source[insertAt - 1] === "\r") insertAt -= 1;
	return `${source.slice(0, insertAt)} // ${handle}${source.slice(insertAt)}`;
}
