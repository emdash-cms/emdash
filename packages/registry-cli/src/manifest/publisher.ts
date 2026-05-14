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

import { randomUUID } from "node:crypto";
import { readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { isDid, isHandle, type Did, type Handle } from "@atcute/lexicons/syntax";
import { applyEdits, modify, parseTree, printParseErrorCode, type ParseError } from "jsonc-parser";

import { createActorResolver } from "../oauth.js";

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
		const source = await readFile(manifestPath, "utf8");

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
		// `formattingOptions.insertSpaces: false` matches the repo's
		// tab-indented JSONC convention. The `getInsertionIndex` callback
		// places `publisher` immediately after `license` (or at the end
		// of the object if `license` isn't present, which shouldn't
		// happen for a schema-valid manifest but is handled defensively).
		const edits = modify(source, ["publisher"], sessionDid, {
			formattingOptions: { insertSpaces: false, tabSize: 1 },
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
		// the inserted line by matching on the DID string (opaque enough
		// to be unique within a single-publisher manifest) and append
		// the comment before the line terminator.
		//
		// The substitution runs ONCE: if the DID happens to appear
		// elsewhere (it shouldn't for a fresh insertion, but defensively
		// anyway), only the first match is annotated.
		const updated = sessionHandle
			? annotatePublisherLine(applied, sessionDid, sessionHandle)
			: applied;

		// Atomic write: tmpfile + rename. POSIX rename is atomic, so a
		// crash mid-write leaves the previous file intact rather than
		// truncating the publisher's manifest.
		const tmp = join(dirname(manifestPath), `.${randomUUID()}.tmp`);
		await writeFile(tmp, updated, "utf8");
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
 * Append `// <handle>` to the line containing the freshly-inserted DID.
 *
 * The match is anchored to the line containing `"<did>"` (the DID is
 * always quoted in JSON) so a substring collision in a different value
 * is impossible. The line may end in `",\n"` (interior key) or `"\n"`
 * (trailing key); we insert the comment BEFORE the line terminator so
 * the comma stays adjacent to the value.
 *
 * If the DID isn't found, returns the input unchanged — the publish-back
 * already succeeded; an unannotated line is a degraded outcome but not
 * a failure.
 *
 * No sanitisation of the handle is needed: `session.handle` is
 * populated by atproto's identity resolver at login time, which only
 * accepts values that (a) match the handle syntax (no control chars,
 * no `/`, no `*`, no whitespace) and (b) round-trip via DoH or
 * `.well-known` to the session DID. An attacker who can put arbitrary
 * bytes into `session.handle` already controls the user's identity.
 */
function annotatePublisherLine(source: string, did: Did, handle: string): string {
	if (handle.length === 0) return source;
	// Match the DID inside its quotes on one line. The DID was emitted
	// by `JSON.stringify` via `jsonc-parser`, so it's safely escaped.
	const needle = `"${did}"`;
	const lineEnd = source.indexOf("\n", source.indexOf(needle));
	if (lineEnd < 0) return source;
	// Walk back past any trailing CR so the comment lands at the end
	// of the *content*, not after a literal "\r" on Windows-authored
	// files.
	let insertAt = lineEnd;
	if (insertAt > 0 && source[insertAt - 1] === "\r") insertAt -= 1;
	return `${source.slice(0, insertAt)} // ${handle}${source.slice(insertAt)}`;
}
