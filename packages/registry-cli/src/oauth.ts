/**
 * OAuth helpers for the registry CLI.
 *
 * Implements the interactive atproto OAuth dance:
 *
 *   1. The CLI binds a loopback HTTP server on a random ephemeral port.
 *   2. The CLI calls `OAuthClient.authorize(...)`, gets an authorization URL,
 *      and asks the user to open it in a browser (best-effort auto-open).
 *   3. The user completes the flow; their browser redirects to
 *      `http://127.0.0.1:<port>/callback?code=...&state=...`.
 *   4. The local server hands the query string to `OAuthClient.callback(...)`,
 *      which exchanges the code for a session, and the server closes.
 *   5. The CLI returns the resulting `OAuthSession` to the caller.
 *
 * The OAuth library handles DPoP, PAR, PKCE, and refresh under the hood. We
 * persist its `StoredSession` blobs to disk via a small filesystem-backed
 * `Store` so subsequent CLI invocations can resume the session without a
 * fresh login.
 */

import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { dirname, join } from "node:path";

import {
	CompositeDidDocumentResolver,
	CompositeHandleResolver,
	DohJsonHandleResolver,
	LocalActorResolver,
	PlcDidDocumentResolver,
	WebDidDocumentResolver,
	WellKnownHandleResolver,
} from "@atcute/identity-resolver";
import type { ActorIdentifier, Did } from "@atcute/lexicons";
import { isDid, isHandle } from "@atcute/lexicons/syntax";
import {
	type LoopbackClientMetadata,
	type OAuthSession,
	OAuthClient,
	type Store,
	type StoredSession,
	type StoredState,
} from "@atcute/oauth-node-client";

import { DEFAULT_OAUTH_DIR } from "./config.js";

// ──────────────────────────────────────────────────────────────────────────
// Filesystem-backed Store<K, V>
// ──────────────────────────────────────────────────────────────────────────

interface FileStoreEnvelope<V> {
	version: number;
	entries: Record<string, V>;
}

const FILE_STORE_VERSION = 1;

/**
 * Generic JSON-file-backed store. Keys are stringified for filenames; values
 * are JSON-serialised in a single envelope file with a version field for
 * forward compatibility.
 *
 * Atomic writes: a temp file is created with mode 0600 and renamed over the
 * target. POSIX rename is atomic, so a crash mid-write leaves the previous
 * file intact.
 */
class FileStore<V> implements Store<string, V> {
	readonly #path: string;
	readonly #cache = new Map<string, V>();
	#loaded = false;

	constructor(path: string) {
		this.#path = path;
	}

	async get(key: string): Promise<V | undefined> {
		await this.#ensureLoaded();
		return this.#cache.get(key);
	}

	async set(key: string, value: V): Promise<void> {
		await this.#ensureLoaded();
		this.#cache.set(key, value);
		await this.#flush();
	}

	async delete(key: string): Promise<void> {
		await this.#ensureLoaded();
		this.#cache.delete(key);
		await this.#flush();
	}

	async clear(): Promise<void> {
		await this.#ensureLoaded();
		this.#cache.clear();
		await this.#flush();
	}

	async #ensureLoaded(): Promise<void> {
		if (this.#loaded) return;
		try {
			const raw = await readFile(this.#path, "utf8");
			const parsed: unknown = JSON.parse(raw);
			if (
				parsed &&
				typeof parsed === "object" &&
				"entries" in parsed &&
				parsed.entries &&
				typeof parsed.entries === "object"
			) {
				// `V` is opaque to the FileStore -- the OAuth library is the
				// only writer and reader, and it round-trips its own typed
				// values through us. We trust whatever's on disk to match the
				// type the same OAuth client wrote. Re-validating here would
				// require duplicating the OAuth library's StoredSession /
				// StoredState schemas.
				// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion
				for (const [k, v] of Object.entries(parsed.entries) as Array<[string, V]>) {
					this.#cache.set(k, v);
				}
			}
		} catch (error) {
			// Missing file is fine; anything else (corruption, permission) we let
			// surface — the user's CLI will then exit non-zero with the error.
			if (!isErrnoException(error) || error.code !== "ENOENT") {
				throw error;
			}
		}
		this.#loaded = true;
	}

	async #flush(): Promise<void> {
		const dir = dirname(this.#path);
		await mkdir(dir, { recursive: true, mode: 0o700 });
		const envelope: FileStoreEnvelope<V> = {
			version: FILE_STORE_VERSION,
			entries: Object.fromEntries(this.#cache),
		};
		const body = `${JSON.stringify(envelope, null, 2)}\n`;
		const tmp = `${this.#path}.tmp`;
		try {
			// `flush: true` (Node 21.1+) fsyncs the file content before close, so
			// a power loss between the rename and a crash can't surface an empty
			// inode pointing at unwritten data. Atomic rename alone is torn-write
			// safe but not durable.
			await writeFile(tmp, body, { mode: 0o600, flush: true });
			await rename(tmp, this.#path);
			// On Linux, fsync the directory after the rename so the rename
			// itself is durable across power loss (POSIX file fsync persists
			// the inode but not the directory entry). On macOS the prior
			// file fsync already covers this via the journal. On Windows
			// `open(dir, "r")` rejects with EISDIR/EACCES; we swallow the
			// error so the write still succeeds. Net effect: durable rename
			// on Linux + journaled FS; benign no-op everywhere else.
			await fsyncDir(dir).catch(() => {});
		} catch (error) {
			// Best-effort cleanup of the temp file if rename failed mid-write.
			await unlink(tmp).catch(() => {});
			throw error;
		}
	}
}

/**
 * fsync a directory so that a rename or unlink inside it is durable across
 * power loss. Node doesn't expose a `fs.fsyncDir` shortcut; the trick is to
 * `open` the directory (read-only) and call `fsync` on the FileHandle.
 * Throws on platforms that reject opening a directory; callers should
 * `.catch(() => {})` since durability is best-effort.
 */
async function fsyncDir(path: string): Promise<void> {
	const handle = await open(path, "r");
	try {
		await handle.sync();
	} finally {
		await handle.close();
	}
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return (
		error instanceof Error &&
		"code" in error &&
		typeof (error as { code?: unknown }).code === "string"
	);
}

// ──────────────────────────────────────────────────────────────────────────
// OAuth client construction
// ──────────────────────────────────────────────────────────────────────────

export interface OAuthClientFactoryOptions {
	/**
	 * Directory for filesystem-backed OAuth state (sessions, in-flight states).
	 * Defaults to `~/.emdash/oauth/`.
	 */
	stateDir?: string;
	/**
	 * Loopback redirect URL the CLI will receive the callback on. The host
	 * portion MUST be the IP literal `127.0.0.1` (RFC 8252 §8.3); `localhost`
	 * is rejected by the atcute OAuth library.
	 */
	redirectUri: `http://127.0.0.1:${number}/callback`;
	/**
	 * Scopes to request. Defaults to `atproto transition:generic`, which is
	 * what the publishing CLI needs to put records in the publisher's repo.
	 */
	scope?: string;
}

/**
 * Build an `OAuthClient` configured as a loopback public client with PKCE.
 *
 * Per RFC 8252, loopback public clients don't need a published client metadata
 * document — the PDS derives metadata from the `client_id` URL parameters.
 * This keeps the CLI self-contained: no JWKS endpoint, no static metadata
 * file, no key management.
 */
export function createCliOAuthClient(options: OAuthClientFactoryOptions): OAuthClient {
	const stateDir = options.stateDir ?? DEFAULT_OAUTH_DIR;

	const sessions = new FileStore<StoredSession>(join(stateDir, "sessions.json"));
	const states = new FileStore<StoredState>(join(stateDir, "states.json"));

	const actorResolver = new LocalActorResolver({
		handleResolver: new CompositeHandleResolver({
			methods: {
				dns: new DohJsonHandleResolver({
					dohUrl: "https://cloudflare-dns.com/dns-query",
				}),
				http: new WellKnownHandleResolver(),
			},
		}),
		didDocumentResolver: new CompositeDidDocumentResolver({
			methods: {
				plc: new PlcDidDocumentResolver(),
				web: new WebDidDocumentResolver(),
			},
		}),
	});

	// Loopback public client per RFC 8252: no client_id, no JWKS, no
	// confidential auth. The PDS derives metadata from the client_id URL
	// parameters during the authorize flow. `redirect_uris` MUST use
	// `127.0.0.1` (not `localhost`) per RFC 8252 §8.3 and the atcute
	// loopbackRedirectUriSchema.
	const metadata: LoopbackClientMetadata = {
		redirect_uris: [options.redirectUri],
		scope: options.scope ?? "atproto transition:generic",
	};

	return new OAuthClient({
		metadata,
		stores: {
			sessions: sessions as Store<Did, StoredSession>,
			states: states as Store<string, StoredState>,
		},
		actorResolver,
	});
}

// ──────────────────────────────────────────────────────────────────────────
// Loopback callback server
// ──────────────────────────────────────────────────────────────────────────

function renderCallbackPage(title: string, message: string): string {
	return `<!doctype html><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}h1{font-size:1.25rem}p{color:#666}</style>
<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p><p><small>You can close this tab.</small></p>`;
}

function escapeHtml(input: string): string {
	return input
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;")
		.replaceAll("/", "&#x2F;");
}

/**
 * Outcome the caller passes back into the loopback server to decide what to
 * render in the user's browser. Only after the caller (atcute) has accepted
 * the callback do we render success; if the callback didn't validate, we
 * render an error so the user knows the login failed.
 */
export type CallbackOutcome =
	| { ok: true; title?: string; message?: string }
	| { ok: false; title?: string; message?: string };

export interface BindLoopbackServerResult {
	redirectUri: `http://127.0.0.1:${number}/callback`;
	/**
	 * Resolves with the OAuth callback URL search params once the AS redirects
	 * the user's browser to `/callback`. Rejects on timeout.
	 *
	 * The HTTP response to the browser is held open until the caller invokes
	 * `respond(...)` -- this lets the caller render success only after the
	 * params have been validated by atcute, and an error message if they
	 * haven't.
	 */
	awaitCallback(): Promise<URLSearchParams>;
	/**
	 * Send the rendered success / error page to the user's browser. Idempotent;
	 * subsequent calls are no-ops. The CLI is expected to call this exactly
	 * once per flow.
	 */
	respond(outcome: CallbackOutcome): void;
	/** Stop the server. Idempotent. */
	close(): Promise<void>;
}

/**
 * Bind a small HTTP server on `127.0.0.1` at an OS-chosen ephemeral port and
 * return a callback path the OAuth flow can redirect to.
 *
 * The server only responds to GET `/callback`. Any other request gets a 405
 * or 400.
 *
 * Importantly, the server holds the response open until the caller invokes
 * `respond(...)` -- so the user's browser shows "Login complete" only AFTER
 * atcute has validated the callback params, not before.
 *
 * @param timeoutMs How long to wait for the callback before rejecting.
 *   Defaults to 5 minutes, matching the typical AS code TTL.
 */
export async function bindLoopbackServer(
	timeoutMs = 5 * 60 * 1000,
): Promise<BindLoopbackServerResult> {
	let resolveCallback: ((params: URLSearchParams) => void) | undefined;
	let rejectCallback: ((error: Error) => void) | undefined;
	let settled = false;

	const callbackPromise = new Promise<URLSearchParams>((resolve, reject) => {
		resolveCallback = (params) => {
			if (settled) return;
			settled = true;
			resolve(params);
		};
		rejectCallback = (error) => {
			if (settled) return;
			settled = true;
			reject(error);
		};
	});

	// Held open until `respond()` is called. The first /callback request
	// captures `pendingResponse`; subsequent ones get a "you've already
	// completed login" message so a refresh / stray tab can't silently re-fire.
	let pendingResponse: ServerResponse | undefined;
	let responded = false;

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method !== "GET") {
			res.statusCode = 405;
			res.setHeader("allow", "GET");
			res.end();
			return;
		}
		if (url.pathname !== "/callback") {
			res.statusCode = 404;
			res.end();
			return;
		}

		// Reject /callback hits with no `state` param. atcute will reject these
		// too, but a stray tab firing at the loopback shouldn't claim the
		// pending promise -- so handle it in-band.
		if (!url.searchParams.has("state")) {
			res.statusCode = 400;
			res.setHeader("content-type", "text/html; charset=utf-8");
			res.end(
				renderCallbackPage(
					"EmDash plugin login",
					"Waiting for the actual login callback. (This request had no state parameter.)",
				),
			);
			return;
		}

		// Already-completed: a second /callback hit (browser refresh, stray
		// tab) gets a generic "you're done" message and doesn't re-trigger.
		if (settled) {
			res.statusCode = 200;
			res.setHeader("content-type", "text/html; charset=utf-8");
			res.end(
				renderCallbackPage(
					"EmDash plugin login",
					"Login already completed. You can close this tab.",
				),
			);
			return;
		}

		// First valid callback: hold the response open until the CLI tells us
		// what to render. The CLI does this once atcute has consumed the params
		// and either accepted them (render success) or rejected (render error).
		pendingResponse = res;
		resolveCallback?.(url.searchParams);
	});

	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => resolve());
	});

	const address = server.address();
	if (!address || typeof address === "string") {
		server.close();
		throw new Error("could not determine loopback server address");
	}
	const port = address.port;
	const redirectUri = `http://127.0.0.1:${port}/callback` as const;

	const timeout = setTimeout(() => {
		rejectCallback?.(new Error(`OAuth callback timed out after ${Math.round(timeoutMs / 1000)}s`));
	}, timeoutMs);
	timeout.unref();

	const respond = (outcome: CallbackOutcome): void => {
		if (responded) return;
		responded = true;
		const res = pendingResponse;
		if (!res) return;
		res.statusCode = outcome.ok ? 200 : 400;
		res.setHeader("content-type", "text/html; charset=utf-8");
		res.end(
			renderCallbackPage(
				outcome.title ?? (outcome.ok ? "EmDash plugin login" : "Login failed"),
				outcome.message ??
					(outcome.ok
						? "Login complete. Returning you to the CLI."
						: "The login callback could not be validated. Check the CLI for details."),
			),
		);
	};

	const close = async (): Promise<void> => {
		clearTimeout(timeout);
		// If we never responded (timeout, error before respond), close the
		// dangling response so the browser doesn't hang.
		if (!responded && pendingResponse) {
			responded = true;
			try {
				pendingResponse.end();
			} catch {
				// the socket may already be gone; safe to ignore
			}
		}
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};

	return {
		redirectUri,
		awaitCallback: () => callbackPromise,
		respond,
		close,
	};
}

// ──────────────────────────────────────────────────────────────────────────
// Browser open (best-effort)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Best-effort attempt to open `url` in the user's default browser. Failure is
 * non-fatal: the CLI prints the URL too, so a headless or sandboxed user can
 * complete the flow manually. We do NOT await the spawned process.
 */
export function tryOpenBrowser(url: string): void {
	void (async () => {
		try {
			const { execFile } = await import("node:child_process");
			if (process.platform === "darwin") {
				execFile("open", [url]);
			} else if (process.platform === "win32") {
				execFile("cmd", ["/c", "start", "", url]);
			} else {
				execFile("xdg-open", [url]);
			}
		} catch {
			// swallowed by design
		}
	})();
}

// ──────────────────────────────────────────────────────────────────────────
// Top-level: run an interactive login
// ──────────────────────────────────────────────────────────────────────────

/**
 * Validate and narrow a user-supplied identifier (handle or DID) to the
 * `ActorIdentifier` type the OAuth library expects. Throws a CLI-shaped error
 * message if neither shape matches.
 */
function parseActorIdentifier(input: string): ActorIdentifier {
	const trimmed = input.trim();
	if (isDid(trimmed) || isHandle(trimmed)) {
		return trimmed;
	}
	throw new Error(
		`"${input}" is not a valid handle or DID. Expected a handle like "alice.example.com" or a DID like "did:plc:abc123..."`,
	);
}

export interface RunInteractiveLoginOptions {
	/** Handle or DID the user wants to authenticate as. */
	identifier: string;
	/** OAuth state directory. Defaults to `~/.emdash/oauth/`. */
	stateDir?: string;
	/** Override the loopback callback timeout. */
	timeoutMs?: number;
	/** Hook for printing the verification URL when the browser-open fails. */
	onUrl?: (url: URL) => void;
}

export interface RunInteractiveLoginResult {
	session: OAuthSession;
	did: Did;
}

/**
 * Run a full interactive OAuth login: build the client, bind the loopback
 * server, open the browser, await the callback, exchange the code, and return
 * the session.
 *
 * On success, the OAuth library has already persisted the session to the
 * filesystem store, so subsequent CLI invocations can call
 * `resumeSession(did)` and skip the interactive flow.
 */
export async function runInteractiveLogin(
	options: RunInteractiveLoginOptions,
): Promise<RunInteractiveLoginResult> {
	const server = await bindLoopbackServer(options.timeoutMs);
	try {
		const client = createCliOAuthClient({
			stateDir: options.stateDir,
			redirectUri: server.redirectUri,
		});

		const identifier = parseActorIdentifier(options.identifier);
		const { url } = await client.authorize({
			target: { type: "account", identifier },
		});

		options.onUrl?.(url);
		tryOpenBrowser(url.toString());

		const params = await server.awaitCallback();
		try {
			const result = await client.callback(params);
			// Atcute has accepted the callback. Only NOW render the success
			// page in the user's browser -- so a stray /callback hit with
			// invalid state can't trick the user into thinking they're logged
			// in when they aren't.
			server.respond({ ok: true });
			return { session: result.session, did: result.session.sub };
		} catch (error) {
			// atcute rejected the callback (state mismatch, expired code, etc).
			// Render an error page in the browser before surfacing the failure.
			const message = error instanceof Error ? error.message : "Login could not be validated.";
			server.respond({ ok: false, message });
			throw error;
		}
	} finally {
		await server.close();
	}
}

/**
 * Resume a previously-stored session by DID, refreshing tokens if needed.
 * Throws if no session exists for the DID.
 *
 * The redirect URI is irrelevant for resume (it's only used during authorize),
 * but the OAuth client constructor requires one matching the stored metadata.
 * We pass a placeholder; the OAuth library never tries to bind it.
 */
export async function resumeSession(
	did: Did,
	options: { stateDir?: string } = {},
): Promise<OAuthSession> {
	const client = createCliOAuthClient({
		stateDir: options.stateDir,
		redirectUri: "http://127.0.0.1:0/callback",
	});
	return client.restore(did);
}

/**
 * Revoke a session and remove its stored state. Best-effort: a network failure
 * during revocation is logged but does not prevent local cleanup, since the
 * user's intent is "stop using this session on this machine".
 */
export async function revokeSession(did: Did, options: { stateDir?: string } = {}): Promise<void> {
	const client = createCliOAuthClient({
		stateDir: options.stateDir,
		redirectUri: "http://127.0.0.1:0/callback",
	});
	try {
		await client.revoke(did);
	} catch {
		// Local-cleanup-only fallback: drop the session entry directly so
		// `restore` won't accidentally reuse a server-side-revoked session.
		const sessions = new FileStore<StoredSession>(
			join(options.stateDir ?? DEFAULT_OAUTH_DIR, "sessions.json"),
		);
		await sessions.delete(did);
	}
}
