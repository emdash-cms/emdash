/**
 * App-password authentication for the registry CLI's `publish` command.
 *
 * The interactive OAuth path (see `./oauth.ts`) doesn't survive a stateless
 * CI runner — refresh tokens rotate single-use, so a runner that publishes
 * once and discards its filesystem leaves the persisted session dead unless
 * the rotated session is written back somewhere durable. Writing back means
 * mutating a GitHub secret (needs a PAT) or threading the token through
 * actions cache (silent miss on a flake). App passwords sidestep all of
 * that: long-lived, re-create a session per run, no write-back.
 *
 * The cost of an app password is that it's coarse — whole-repo write rather
 * than the `repo:<nsid>` granularity OAuth grants. We mitigate that with the
 * guardrails below: only `appPass` / `appPassPrivileged`-scoped tokens are
 * accepted; the full-account `com.atproto.access` scope is rejected so a
 * pasted account password fails loudly instead of publishing.
 *
 * Defines the `PublishAuth` two-phase interface that both this provider and
 * the OAuth provider in `publish.ts` implement. `identify()` may hit the
 * network for the app-password path (we don't know the DID until login
 * succeeds); `handler()` then returns the already-logged-in
 * `CredentialManager` without a second round trip.
 */

import type { FetchHandlerObject } from "@atcute/client";
import { CredentialManager } from "@atcute/client";
import type { ActorResolver } from "@atcute/identity-resolver";
import type { Did } from "@atcute/lexicons";

import { createActorResolver, parseActorIdentifier } from "./oauth.js";

/**
 * Two-phase auth abstraction consumed by `runPublish`. The split exists so
 * the OAuth fast-fail (publisher-pin check before tarball fetch) is preserved
 * for OAuth, while the app-password path can defer its network work until
 * `identify()` is called — itself still BEFORE the tarball fetch, so bad
 * credentials fail before downloading.
 *
 * Implementations:
 *   - OAuth: `identify()` reads the local credential store (offline);
 *     `handler()` resumes the stored session (network, post-tarball-fetch).
 *   - App-password: `identify()` resolves the identifier, logs in, runs
 *     guardrails (network, pre-tarball-fetch); `handler()` returns the
 *     cached, already-authenticated manager (no network).
 */
export interface PublishAuth {
	/**
	 * Resolve `{ did, handle, pds }` for the active publisher. For OAuth this
	 * is offline; for app-password it performs the actorResolver lookup and
	 * the `createSession` call. `handle` may be null for OAuth sessions that
	 * never recorded one; the app-password provider always sets it (the PDS
	 * returns a handle in the createSession response).
	 */
	identify(): Promise<PublisherIdentity>;
	/**
	 * Return a fetch handler authenticated as the publisher. Must be called
	 * AFTER `identify()` — the order matches the OAuth path, where the
	 * handler is only built once the session DID is known.
	 */
	handler(): Promise<FetchHandlerObject>;
}

export interface PublisherIdentity {
	did: Did;
	handle: string | null;
	pds: string;
}

/**
 * Stable error code surfaced through `CliError` so `--json` mode can emit
 * `{ error: { code, message } }` for CI consumers. Each one corresponds to
 * an exact failure mode in the app-password path; matching against the code
 * is the supported contract.
 */
export type AppPasswordErrorCode =
	| "MISSING_APP_PASSWORD"
	| "MISSING_PUBLISHER"
	| "APP_PASSWORD_FORMAT"
	| "FULL_ACCOUNT_CREDENTIAL"
	| "PUBLISHER_DID_MISMATCH"
	| "APP_PASSWORD_LOGIN_FAILED"
	| "INVALID_PUBLISHER";

export class AppPasswordError extends Error {
	override readonly name = "AppPasswordError";
	readonly exitCode: number;
	constructor(
		readonly code: AppPasswordErrorCode,
		message: string,
	) {
		super(message);
		this.exitCode = USER_CONFIG_CODES.has(code) ? 2 : 1;
	}
}

/**
 * Exit code 2 is reserved for user-side configuration mistakes (bad flag, bad
 * env var, malformed password) — the same shape as citty's own arg-validation
 * failures. Anything that could result from a transient network condition
 * (`INVALID_PUBLISHER`, `APP_PASSWORD_LOGIN_FAILED`) stays at exit 1 so CI
 * scripts that branch on exit code don't misclassify a PLC/DNS blip as a
 * config error.
 */
const USER_CONFIG_CODES = new Set<AppPasswordErrorCode>([
	"MISSING_APP_PASSWORD",
	"MISSING_PUBLISHER",
	"APP_PASSWORD_FORMAT",
]);

export interface CreateAppPasswordAuthOptions {
	/** Raw publisher identifier (handle or DID) from --publisher / env. */
	identifier: string;
	/** App-password string from `EMDASH_PUBLISHER_APP_PASSWORD`. */
	password: string;
	/**
	 * Override the actor resolver. Production code omits this and gets the
	 * shared `LocalActorResolver` from `oauth.ts`. Tests pass a stub so handle
	 * / DID resolution doesn't hit PLC or the DNS handle resolver.
	 */
	actorResolver?: ActorResolver;
	/**
	 * Override the fetch implementation handed to `CredentialManager`. Tests
	 * use this to route `createSession` (and subsequent authenticated requests
	 * once the manager is acting as the PublishingClient handler) at the mock
	 * PDS. Production uses the global `fetch`.
	 */
	fetch?: typeof globalThis.fetch;
}

/**
 * Build a `PublishAuth` provider that logs in with an atproto app password.
 *
 * `identify()` is where every guardrail lives:
 *
 *   1. The identifier is validated as a handle or DID (no email-shaped
 *      identifiers — see {@link parseActorIdentifier}).
 *   2. The password is checked against the atproto app-password format
 *      `xxxx-xxxx-xxxx-xxxx` so a pasted account password fails before any
 *      network call.
 *   3. The identifier is resolved to `{ did, pds }`.
 *   4. `createSession` runs against the resolved PDS.
 *   5. The returned access JWT's `scope` is checked — `com.atproto.access`
 *      (full account) is rejected; both app-password scopes accepted.
 *   6. The logged-in DID is cross-checked against the resolved identifier
 *      DID. A mismatch refuses to publish (we'd be writing to the wrong
 *      repo).
 *
 * After `identify()` succeeds, `handler()` returns the same authenticated
 * `CredentialManager` — no second login, no token persistence (CI sessions
 * are explicitly transient).
 */
export function createAppPasswordAuth(options: CreateAppPasswordAuthOptions): PublishAuth {
	const actor = parseActorIdentifier(options.identifier);
	if (!isWellFormedAppPassword(options.password)) {
		throw new AppPasswordError(
			"APP_PASSWORD_FORMAT",
			"EMDASH_PUBLISHER_APP_PASSWORD does not look like an atproto app password " +
				"(expected `xxxx-xxxx-xxxx-xxxx`, lowercase alphanumeric). " +
				"Create one at https://bsky.app/settings/app-passwords or your PDS equivalent, " +
				"not the account password.",
		);
	}

	// Cache the in-flight promise rather than just the resolved value: two
	// concurrent `identify()` calls (or an `identify()` racing a `handler()`)
	// share one `createSession` round trip. On failure the promise field is
	// cleared so a subsequent call retries instead of returning a stuck
	// rejection.
	let pending: Promise<{ identity: PublisherIdentity; manager: CredentialManager }> | null = null;

	const ensureLoggedIn = async () => {
		if (pending) return pending;
		pending = (async () => {
			const resolver = options.actorResolver ?? createActorResolver();
			let resolved;
			try {
				resolved = await resolver.resolve(actor);
			} catch (error) {
				throw new AppPasswordError(
					"INVALID_PUBLISHER",
					`Could not resolve publisher ${actor}: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			const manager = new CredentialManager({
				service: resolved.pds,
				...(options.fetch ? { fetch: options.fetch } : {}),
			});
			let session;
			try {
				// Send the parsed identifier (trimmed by `parseActorIdentifier`),
				// not the raw `options.identifier`. A stray space in
				// `EMDASH_PUBLISHER_HANDLE` shouldn't reach the PDS as a leading
				// whitespace character — `createSession` would 400 with an opaque
				// error and the publisher would have no idea why.
				session = await manager.login({
					identifier: actor,
					password: options.password,
				});
			} catch (error) {
				throw new AppPasswordError(
					"APP_PASSWORD_LOGIN_FAILED",
					`Login to ${resolved.pds} as ${actor} failed: ${
						error instanceof Error ? error.message : String(error)
					}`,
				);
			}
			assertNonFullAccountScope(session.accessJwt);
			if (session.did !== resolved.did) {
				throw new AppPasswordError(
					"PUBLISHER_DID_MISMATCH",
					`Publisher ${actor} resolved to ${resolved.did}, but the credentials ` +
						`authenticated as ${session.did}. Refusing to publish to the wrong repo. ` +
						"Check the --publisher / EMDASH_PUBLISHER_* values match the account that owns " +
						"the app password.",
				);
			}
			return {
				identity: { did: session.did, handle: session.handle, pds: resolved.pds },
				manager,
			};
		})();
		try {
			return await pending;
		} catch (error) {
			pending = null;
			throw error;
		}
	};

	return {
		async identify(): Promise<PublisherIdentity> {
			const { identity } = await ensureLoggedIn();
			return identity;
		},
		async handler(): Promise<FetchHandlerObject> {
			const { manager } = await ensureLoggedIn();
			return manager;
		},
	};
}

export interface SelectPublishAuthArgs {
	/** Value of the `--publisher` CLI flag, if any. */
	publisher?: string;
}

export interface SelectPublishAuthOptions {
	/** Environment to read. Defaults to `process.env`. Tests pass a literal map. */
	env?: NodeJS.ProcessEnv;
	/**
	 * Factory for the OAuth `PublishAuth`. Defaults to whatever the caller has
	 * wired into publish.ts. Decoupled so this module can stay free of the
	 * OAuth-specific filesystem dependencies — they live in the existing
	 * credentials store, not here.
	 */
	oauthFactory: () => PublishAuth;
	/** Override the actor resolver for app-password tests. */
	actorResolver?: ActorResolver;
	/** Override the fetch implementation for app-password tests. */
	fetch?: typeof globalThis.fetch;
}

/**
 * Pick the right `PublishAuth` based on environment + flag state. Selection
 * rule: presence of `EMDASH_PUBLISHER_APP_PASSWORD` selects the app-password
 * path. Absent → OAuth (default, interactive `emdash-plugin login`).
 *
 * Identifier precedence when on the app-password path:
 *   1. `--publisher` flag
 *   2. `EMDASH_PUBLISHER_DID` env
 *   3. `EMDASH_PUBLISHER_HANDLE` env
 *
 * Misconfiguration is loud, not silent: identifier without password and
 * password without identifier both fail with a distinct, stable error code
 * rather than falling back to the wrong path (CI debugging from an
 * accidental OAuth attempt is significantly worse than a clear error).
 */
export function selectPublishAuth(
	args: SelectPublishAuthArgs,
	options: SelectPublishAuthOptions,
): PublishAuth {
	const env = options.env ?? process.env;
	// `??` doesn't fall through "" (`undefined`/`null` only) — but an explicit
	// `--publisher=""` should defer to env, and `EMDASH_PUBLISHER_DID=""` should
	// defer to the handle var. `firstNonBlank` treats whitespace-only strings as
	// absent so a stray `EMDASH_PUBLISHER_HANDLE= ` in a CI YAML doesn't latch.
	const password = firstNonBlank(env.EMDASH_PUBLISHER_APP_PASSWORD);
	const identifier = firstNonBlank(
		args.publisher,
		env.EMDASH_PUBLISHER_DID,
		env.EMDASH_PUBLISHER_HANDLE,
	);

	if (password) {
		if (!identifier) {
			throw new AppPasswordError(
				"MISSING_PUBLISHER",
				"EMDASH_PUBLISHER_APP_PASSWORD is set but no publisher identifier was provided. " +
					"Pass --publisher <handle-or-did>, or set EMDASH_PUBLISHER_DID / EMDASH_PUBLISHER_HANDLE.",
			);
		}
		return createAppPasswordAuth({
			identifier,
			password,
			...(options.actorResolver ? { actorResolver: options.actorResolver } : {}),
			...(options.fetch ? { fetch: options.fetch } : {}),
		});
	}
	if (identifier) {
		throw new AppPasswordError(
			"MISSING_APP_PASSWORD",
			`Publisher identifier ${identifier} was provided but EMDASH_PUBLISHER_APP_PASSWORD is empty. ` +
				"Set the app-password env var, or drop the identifier to fall back to interactive OAuth " +
				"(`emdash-plugin login`).",
		);
	}
	return options.oauthFactory();
}

/**
 * Return the first argument that's a non-blank string, or `undefined` if none
 * are. Used by selection so explicit empty / whitespace-only env vars don't
 * shadow the next fallback in the chain.
 */
function firstNonBlank(...candidates: Array<string | undefined>): string | undefined {
	for (const candidate of candidates) {
		if (typeof candidate !== "string") continue;
		const trimmed = candidate.trim();
		if (trimmed.length > 0) return trimmed;
	}
	return undefined;
}

/**
 * Atproto app passwords are issued in the shape `xxxx-xxxx-xxxx-xxxx`, four
 * groups of four lowercase alphanumeric characters joined by hyphens.
 * Catching the common "publisher pasted the account password" mistake here
 * means we never send the account password to `createSession`.
 */
const APP_PASSWORD_RE = /^[a-z0-9]{4}(-[a-z0-9]{4}){3}$/;

export function isWellFormedAppPassword(password: string): boolean {
	return APP_PASSWORD_RE.test(password);
}

/**
 * Decode the access JWT payload and refuse the full-account scope.
 *
 * Three scopes can come back from `createSession`:
 *   - `com.atproto.access`            — full account credentials. Refused.
 *   - `com.atproto.appPass`           — app password, non-privileged. Accepted.
 *   - `com.atproto.appPassPrivileged` — app password with extra privileges
 *                                       (e.g. direct messages). Still not the
 *                                       account password; accepted.
 *
 * Decoding is signature-unverified by design — the PDS already enforces the
 * scope binding server-side, and we'd need its public key to verify locally.
 * Re-reading the scope client-side is purely a footgun-catcher: if a
 * publisher pastes the account password, the PDS returns
 * `com.atproto.access`, and we surface that as a hard error before the
 * publish goes through.
 */
function assertNonFullAccountScope(accessJwt: string): void {
	const payload = decodeJwtPayload(accessJwt);
	const scope =
		payload && typeof payload === "object" ? (payload as { scope?: unknown }).scope : undefined;
	if (scope === "com.atproto.access") {
		throw new AppPasswordError(
			"FULL_ACCOUNT_CREDENTIAL",
			"EMDASH_PUBLISHER_APP_PASSWORD authenticated with the full-account scope " +
				"(`com.atproto.access`). Refusing to publish with account credentials — " +
				"create a dedicated app password at https://bsky.app/settings/app-passwords " +
				"or your PDS equivalent and use that instead.",
		);
	}
}

/**
 * Best-effort base64url JSON decode of a JWT payload. The signature is not
 * checked — the PDS enforces scope server-side, and this is advisory only
 * (see {@link assertNonFullAccountScope}).
 *
 * Returns `null` on any malformed input. Callers treat `null` as "couldn't
 * tell the scope" rather than throwing — an unrecognised JWT shouldn't
 * pretend to be a full-account credential.
 */
function decodeJwtPayload(jwt: string): unknown {
	const parts = jwt.split(".");
	if (parts.length < 2) return null;
	const payload = parts[1];
	if (!payload) return null;
	const padded = payload.replaceAll("-", "+").replaceAll("_", "/");
	const padding = padded.length % 4 === 0 ? "" : "=".repeat(4 - (padded.length % 4));
	try {
		const json = Buffer.from(padded + padding, "base64").toString("utf8");
		return JSON.parse(json);
	} catch {
		return null;
	}
}
