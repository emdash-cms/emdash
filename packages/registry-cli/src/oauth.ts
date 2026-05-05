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

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
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
		await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
		const envelope: FileStoreEnvelope<V> = {
			version: FILE_STORE_VERSION,
			entries: Object.fromEntries(this.#cache),
		};
		const body = `${JSON.stringify(envelope, null, 2)}\n`;
		const tmp = `${this.#path}.tmp`;
		try {
			await writeFile(tmp, body, { mode: 0o600 });
			await rename(tmp, this.#path);
		} catch (error) {
			// Best-effort cleanup of the temp file if rename failed mid-write.
			await unlink(tmp).catch(() => {});
			throw error;
		}
	}
}

function isErrnoException(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
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

function renderCallbackPage(message: string): string {
	return `<!doctype html><meta charset="utf-8"><title>EmDash plugin login</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#222}h1{font-size:1.25rem}p{color:#666}</style>
<h1>EmDash plugin login</h1><p>${escapeHtml(message)}</p><p><small>You can close this tab.</small></p>`;
}

function escapeHtml(input: string): string {
	return input
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;");
}

export interface BindLoopbackServerResult {
	redirectUri: `http://127.0.0.1:${number}/callback`;
	awaitCallback(): Promise<URLSearchParams>;
	close(): Promise<void>;
}

/**
 * Bind a small HTTP server on `127.0.0.1` at an OS-chosen ephemeral port and
 * return a callback path the OAuth flow can redirect to.
 *
 * The server only responds to GET `/callback`. Any other request gets a 404.
 *
 * @param timeoutMs How long to wait for the callback before rejecting.
 *   Defaults to 5 minutes, matching the typical AS code TTL.
 */
export async function bindLoopbackServer(
	timeoutMs = 5 * 60 * 1000,
): Promise<BindLoopbackServerResult> {
	let resolveCallback: ((params: URLSearchParams) => void) | undefined;
	let rejectCallback: ((error: Error) => void) | undefined;

	const callbackPromise = new Promise<URLSearchParams>((resolve, reject) => {
		resolveCallback = resolve;
		rejectCallback = reject;
	});

	const server = createServer((req: IncomingMessage, res: ServerResponse) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		if (req.method !== "GET" || url.pathname !== "/callback") {
			res.statusCode = 404;
			res.end();
			return;
		}
		res.statusCode = 200;
		res.setHeader("content-type", "text/html; charset=utf-8");
		res.end(renderCallbackPage("Login complete. Returning you to the CLI."));
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

	const close = async (): Promise<void> => {
		clearTimeout(timeout);
		await new Promise<void>((resolve) => server.close(() => resolve()));
	};

	return {
		redirectUri,
		awaitCallback: () => callbackPromise,
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
		const result = await client.callback(params);

		return { session: result.session, did: result.session.sub };
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
