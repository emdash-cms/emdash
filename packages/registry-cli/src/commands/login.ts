/**
 * `emdash-registry login <handle-or-did>`
 *
 * Interactive atproto OAuth login. Spins up a loopback HTTP server, opens the
 * user's browser at the AS authorization URL, awaits the callback, exchanges
 * the code, and persists the resulting session.
 *
 * Records the publisher's DID/handle/PDS into the EmDash credentials store
 * (`~/.emdash/credentials.json` by default) so subsequent registry commands
 * can identify the active publisher without cracking open the OAuth library's
 * `StoredSession`.
 */

import { isHandle } from "@atcute/lexicons/syntax";
import { OAuthCallbackError, OAuthResponseError } from "@atcute/oauth-node-client";
import { FileCredentialStore } from "@emdash-cms/registry-client";
import { defineCommand } from "citty";
import { consola } from "consola";
import pc from "picocolors";

import { runInteractiveLogin } from "../oauth.js";
import { resolveAtprotoProfile } from "../profile.js";

const BODY_SNIPPET_MAX_CHARS = 200;
const WHITESPACE_RUN = /\s+/g;

/**
 * Read up to `BODY_SNIPPET_MAX_CHARS` of the response body, collapsed to a
 * single line. Returns null if the body is empty or can't be read. Used to
 * surface what the PDS actually returned when the OAuth library couldn't
 * extract an `error` / `error_description` from the JSON body and fell back
 * to its `unknown_error` placeholder.
 */
async function readBodySnippet(response: Response): Promise<string | null> {
	try {
		const text = await response.clone().text();
		if (!text) return null;
		const oneLine = text.replace(WHITESPACE_RUN, " ").trim();
		if (!oneLine) return null;
		return oneLine.length > BODY_SNIPPET_MAX_CHARS
			? `${oneLine.slice(0, BODY_SNIPPET_MAX_CHARS)}…`
			: oneLine;
	} catch {
		return null;
	}
}

/**
 * Render an OAuth response error as a clean CLI message. The atcute library
 * surfaces these as `OAuthResponseError` with `error: "unknown_error"` whenever
 * the AS response wasn't an OAuth-shaped JSON body — most often a transient
 * gateway/PDS hiccup. Without this, users just see "ERROR unknown_error" and a
 * stack trace, which doesn't help them tell "PDS hiccup" from "config issue".
 */
async function reportOAuthFailure(error: OAuthResponseError): Promise<void> {
	const { status } = error;
	const statusText = error.response.statusText;
	const endpoint = error.response.url;

	const statusLine = statusText ? `HTTP ${status} ${statusText}` : `HTTP ${status}`;
	consola.error(`Login failed: PDS responded with ${statusLine}`);
	if (endpoint) consola.info(`Endpoint: ${pc.dim(endpoint)}`);

	if (error.errorDescription) {
		consola.info(`Reason: ${error.errorDescription}`);
	} else if (error.error && error.error !== "unknown_error") {
		consola.info(`Reason: ${error.error}`);
	}

	if (error.error === "unknown_error") {
		const snippet = await readBodySnippet(error.response);
		if (snippet) consola.info(`Body: ${pc.dim(snippet)}`);
	}

	if (status >= 500) {
		consola.info("This looks like a transient server error — try again in a moment.");
	}
}

export const loginCommand = defineCommand({
	meta: {
		name: "login",
		description: "Log in to the plugin registry via your Atmosphere account (atproto OAuth)",
	},
	args: {
		identifier: {
			type: "positional",
			description: "Your handle (e.g. alice.example.com) or DID",
			required: true,
		},
		json: {
			type: "boolean",
			description: "Output result as JSON",
		},
	},
	async run({ args }) {
		const identifier = args.identifier.trim();

		consola.start(`Logging in as ${pc.bold(identifier)}...`);

		let result: Awaited<ReturnType<typeof runInteractiveLogin>>;
		try {
			result = await runInteractiveLogin({
				identifier,
				onUrl: (url) => {
					console.log();
					consola.info("Open your browser to:");
					console.log(`  ${pc.cyan(pc.bold(url.toString()))}`);
					console.log();
					consola.info("Waiting for authorization...");
				},
				onLegacyScopeFallback: () => {
					consola.warn(
						"Your PDS rejected the granular OAuth scopes; falling back to legacy `transition:generic`.",
					);
					consola.info(
						"This grants the CLI broader permissions than it needs. Ask your PDS operator to update to a build that supports the atproto granular permission spec.",
					);
				},
			});
		} catch (error) {
			if (error instanceof OAuthResponseError) {
				await reportOAuthFailure(error);
				process.exit(1);
			}
			if (error instanceof OAuthCallbackError) {
				consola.error(`Login failed: ${error.errorDescription ?? error.error}`);
				if (error.errorDescription && error.error !== error.errorDescription) {
					consola.info(`Error code: ${error.error}`);
				}
				process.exit(1);
			}
			throw error;
		}

		const { displayName, handle, pds } = await resolveAtprotoProfile(result.session);

		// `resolveAtprotoProfile` falls back to the DID when handle
		// resolution fails. We persist `null` rather than a placeholder so
		// downstream display code can render the DID directly instead of a
		// fake "unknown.invalid"-style handle that misleads users.
		const handleForStorage: string | null = isHandle(handle) ? handle : null;
		const credentials = new FileCredentialStore();
		await credentials.put({
			did: result.did,
			handle: handleForStorage,
			pds,
			updatedAt: Date.now(),
		});

		if (args.json) {
			console.log(
				JSON.stringify({
					did: result.did,
					handle: handleForStorage,
					displayName,
					pds,
				}),
			);
			return;
		}

		consola.success(
			`Logged in as ${pc.bold(handleForStorage ?? result.did)}${displayName ? ` (${displayName})` : ""}`,
		);
		if (handleForStorage) consola.info(`DID: ${pc.dim(result.did)}`);
		if (pds) consola.info(`PDS: ${pc.dim(pds)}`);
	},
});
