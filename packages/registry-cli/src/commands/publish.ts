/**
 * `emdash-registry publish --url <url>`
 *
 * Thin citty wrapper around `publishRelease` from `../publish/api.js`.
 *
 * Responsibilities here are limited to:
 *   - parsing args and reading filesystem credentials,
 *   - fetching the tarball at `--url` (with URL/size guards) so the API has
 *     bytes to work with,
 *   - extracting the manifest from those bytes BEFORE printing any tarball
 *     metadata so users don't see "looks good" output for a malformed file,
 *   - opening an authenticated `PublishingClient` from the OAuth session,
 *   - rendering the API's structured output through consola,
 *   - exiting non-zero on `PublishError`.
 *
 * Everything else (FAIR's immutability rule, profile bootstrap validation,
 * deprecated-capability hard-fail, AT URI construction) lives in the API so
 * tests can run it against a mock PDS.
 */

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { PluginManifest } from "@emdash-cms/plugin-types";
import { FileCredentialStore, PublishingClient } from "@emdash-cms/registry-client";
import { defineCommand } from "citty";
import consola from "consola";
import pc from "picocolors";

import { sha256Multihash } from "../multihash.js";
import { resumeSession } from "../oauth.js";
import {
	PublishError,
	publishRelease,
	type ProfileBootstrap,
	type PublishLogger,
} from "../publish/api.js";

/** Hard cap on tarball size we'll buffer into memory. Mirrors MAX_BUNDLE_SIZE. */
const MAX_TARBALL_BYTES = 5 * 1024 * 1024;

export const publishCommand = defineCommand({
	meta: {
		name: "publish",
		description:
			"Publish a sandboxed plugin release to the registry (atproto + FAIR-shaped records)",
	},
	args: {
		url: {
			type: "string",
			description: "Public URL where the tarball is hosted (artifact source-of-truth)",
			required: true,
		},
		local: {
			type: "string",
			description:
				"Optional path to a local copy of the tarball at --url. The CLI still downloads the URL (it has to compute the checksum from what consumers will fetch), but cross-checks the local bytes match. Use this to catch a stale upload before publishing.",
		},
		license: {
			type: "string",
			description:
				"SPDX license expression. Required on first publish; ignored thereafter (the existing profile wins)",
		},
		"author-name": {
			type: "string",
			description: "Author display name (first publish only)",
		},
		"author-url": {
			type: "string",
			description: "Author URL (first publish only)",
		},
		"author-email": {
			type: "string",
			description: "Author email (first publish only)",
		},
		"security-email": {
			type: "string",
			description: "Security contact email. Required on first publish; ignored thereafter",
		},
		"security-url": {
			type: "string",
			description: "Security contact URL (first publish only)",
		},
		"allow-overwrite": {
			type: "boolean",
			description:
				"Allow overwriting an existing release at <slug>:<version>. Default refuses, since FAIR treats version records as immutable and aggregators/labellers may flag any change as a takedown event.",
			default: false,
		},
		json: {
			type: "boolean",
			description: "Output result as JSON",
		},
	},
	async run({ args }) {
		// In --json mode, stdout MUST contain only the final JSON object so
		// callers can `emdash-registry publish ... --json | jq`. Route every
		// consola log line to stderr; capture the previous reporter set so we
		// can restore in the finally below (matters when the CLI is exec'd
		// in-process by tests or wrappers).
		const restoreReporters = args.json ? redirectConsolaToStderr() : null;
		try {
			await runPublish(args);
		} catch (error) {
			handlePublishError(error, args.json);
			process.exit(1);
		} finally {
			restoreReporters?.();
		}
	},
});

/**
 * Inner publish flow. Throws on every failure path; the outer `run` catches
 * and renders consistently (human + JSON modes).
 */
async function runPublish(args: PublishArgs): Promise<void> {
	// Validate URL before any network access. Empty or non-https URLs are
	// rejected so we never publish a record pointing at file:// or a private
	// IP that consumers won't be able to fetch from.
	const urlError = validatePublishUrl(args.url);
	if (urlError) throw new CliError(urlError, 2, "INVALID_URL");

	// Reject empty-string flags up front. citty leaves them as "" rather
	// than undefined, and the publish API treats "" as missing -- bad UX.
	const stringFlagError = validateStringFlags({
		license: args.license,
		"author-name": args["author-name"],
		"author-url": args["author-url"],
		"author-email": args["author-email"],
		"security-email": args["security-email"],
		"security-url": args["security-url"],
	});
	if (stringFlagError) throw new CliError(stringFlagError, 2, "INVALID_FLAG");

	// Fetch + checksum the tarball, then extract the manifest BEFORE we
	// print any reassuring "tarball looks fine" lines. A 200 from a CDN
	// can serve an HTML 404 page; we want the failure to land before the
	// user sees apparent success.
	consola.start(`Fetching ${args.url}...`);
	const tarballBytes = await fetchTarball(args.url);
	const checksum = sha256Multihash(tarballBytes);
	const manifest = await extractManifestFromTarball(tarballBytes);

	consola.info(`Tarball: ${formatBytes(tarballBytes.length)}`);
	consola.info(`Multihash: ${pc.dim(checksum)}`);
	consola.info(`Manifest: ${pc.bold(manifest.id)}@${manifest.version}`);

	// Optional local cross-check.
	if (args.local) {
		const localPath = resolve(args.local);
		const localBytes = await readFile(localPath);
		const localChecksum = sha256Multihash(localBytes);
		if (localChecksum !== checksum) {
			throw new CliError(
				`Local file ${localPath} does not match the bytes served at ${args.url}. Local multihash: ${localChecksum}; remote multihash: ${checksum}. Re-upload the correct tarball, or drop --local to publish whatever's at the URL.`,
				1,
				"LOCAL_CHECKSUM_MISMATCH",
			);
		}
		consola.success(`Local file at ${pc.dim(localPath)} matches the URL`);
	}

	// Resume the active publisher session.
	const credentials = new FileCredentialStore();
	const session = await credentials.current();
	if (!session) {
		throw new CliError(
			"Not logged in. Run: emdash-registry login <handle-or-did>",
			1,
			"NOT_LOGGED_IN",
		);
	}
	consola.info(`Publishing as ${pc.bold(session.handle)} (${pc.dim(session.did)})`);

	const oauthSession = await resumeSession(session.did);
	const publisher = PublishingClient.fromHandler({
		handler: oauthSession,
		did: session.did,
		pds: session.pds,
	});

	const profile: ProfileBootstrap = {
		...(args.license !== undefined ? { license: args.license } : {}),
		...(args["author-name"] !== undefined ? { authorName: args["author-name"] } : {}),
		...(args["author-url"] !== undefined ? { authorUrl: args["author-url"] } : {}),
		...(args["author-email"] !== undefined ? { authorEmail: args["author-email"] } : {}),
		...(args["security-email"] !== undefined ? { securityEmail: args["security-email"] } : {}),
		...(args["security-url"] !== undefined ? { securityUrl: args["security-url"] } : {}),
	};

	const logger: PublishLogger = {
		info: (m) => consola.info(m),
		success: (m) => consola.success(m),
		warn: (m) => consola.warn(m),
	};

	const result = await publishRelease({
		publisher,
		did: session.did,
		manifest,
		checksum,
		url: args.url,
		profile,
		allowOverwrite: args["allow-overwrite"],
		logger,
	});

	// Subsequent-publish: warn about ignored first-publish-only flags.
	if (!result.profileCreated && result.ignoredProfileFields.length > 0) {
		const flags = result.ignoredProfileFields.map(profileFieldToFlag).join(", ");
		consola.warn(
			`Ignored on subsequent publish (existing profile wins): ${flags}. Profile updates aren't supported yet; edit the record directly via your PDS for now.`,
		);
	}

	if (args.json) {
		// Stdout-clean JSON for pipe consumers.
		process.stdout.write(
			`${JSON.stringify({
				profile: result.profileUri,
				release: result.releaseUri,
				cid: result.releaseCid,
				checksum: result.checksum,
				url: args.url,
				profileCreated: result.profileCreated,
				releaseOverwritten: result.releaseOverwritten,
			})}\n`,
		);
		return;
	}

	consola.success(`Published ${pc.bold(`${result.slug}@${manifest.version}`)}`);
	consola.info(`Release URI: ${pc.dim(result.releaseUri)}`);
	consola.info(`Profile URI: ${pc.dim(result.profileUri)}`);
	console.log();
	consola.info(
		`The aggregator will pick this up from the firehose. To verify discovery once it's indexed:`,
	);
	console.log(`  ${pc.cyan(`emdash-registry info ${session.handle} ${result.slug}`)}`);
}

/**
 * Render any error from the publish flow, in human or JSON shape. Always
 * writes to stderr (consola was already redirected for --json mode); in
 * --json mode also writes a structured `{ error: { code, message } }` to
 * stdout so a piped consumer can parse failures the same way they parse
 * successes.
 */
function handlePublishError(error: unknown, jsonMode: boolean): void {
	let code = "INTERNAL_ERROR";
	let message = "Internal error";
	if (error instanceof PublishError) {
		code = error.code;
		message = error.message;
		consola.error(error.message);
		if (error.code === "RELEASE_ALREADY_PUBLISHED") {
			consola.error(
				"To overwrite anyway, pass --allow-overwrite (use only when you're sure no consumers have installed this version yet).",
			);
		}
	} else if (error instanceof CliError) {
		code = error.code;
		message = error.message;
		consola.error(error.message);
	} else if (error instanceof Error) {
		message = error.message;
		consola.error(error);
	} else {
		message = String(error);
		consola.error(error);
	}
	if (jsonMode) {
		process.stdout.write(`${JSON.stringify({ error: { code, message } })}\n`);
	}
}

/**
 * Internal CLI-only error with a stable code, so JSON mode can surface a
 * structured failure shape without the caller having to map raw Error
 * messages.
 */
class CliError extends Error {
	override readonly name = "CliError";
	constructor(
		message: string,
		readonly exitCode: number,
		readonly code: string,
	) {
		super(message);
	}
}

/** citty arg shape for the publish command. Inferred from the schema below. */
type PublishArgs = {
	url: string;
	local?: string;
	license?: string;
	"author-name"?: string;
	"author-url"?: string;
	"author-email"?: string;
	"security-email"?: string;
	"security-url"?: string;
	"allow-overwrite"?: boolean;
	json?: boolean;
};

// ── helpers ──────────────────────────────────────────────────────────────────

/**
 * Reroute every consola log call to stderr. Used by `--json` mode so the
 * structured JSON object on stdout is the only thing a pipe consumer sees.
 *
 * Returns a restore function that puts the previous reporter set back. The
 * outer `run` calls it in a finally so a wrapper script that runs publish
 * in-process and then continues with other commands gets its consola back.
 *
 * We replace the global reporter (rather than constructing a separate
 * instance) so downstream helpers that import the default `consola`
 * singleton are also redirected.
 */
function redirectConsolaToStderr(): () => void {
	// `consola.options.reporters` is the public way to read the active set.
	const previous = consola.options.reporters?.slice() ?? [];
	consola.setReporters([
		{
			log(logObj) {
				const level = logObj.type ?? "info";
				const tag = logObj.tag ? `[${logObj.tag}] ` : "";
				const args = logObj.args ?? [];
				const message = args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
				process.stderr.write(`${level}: ${tag}${message}\n`);
			},
		},
	]);
	return () => {
		consola.setReporters(previous);
	};
}

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Validate the publish URL before any network access. Returns an error message
 * to print, or `null` if the URL is acceptable.
 *
 * The CLI runs locally so the SSRF surface is the publisher's own machine,
 * not a server. The real harm is publishing a record pointing at a
 * non-public URL: consumers can't install from `file:///` or `http://192.x`
 * and end up with a broken record in the registry. We reject those up front.
 */
function validatePublishUrl(url: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		return `--url is not a valid URL: ${url}`;
	}
	// Require https. Tarball integrity is enforced by the multihash we publish
	// alongside the URL, so a MITM can't substitute the bytes -- consumers
	// will reject a checksum mismatch. But TLS still matters here: it
	// prevents an active attacker from observing which plugin versions the
	// publisher is shipping, and it shuts the door on novel checksum-bypass
	// attacks (e.g. a lexicon evolution that loosens checksum verification).
	// The cost is near-zero -- no public CDN serves http-only in 2026.
	if (parsed.protocol !== "https:") {
		return `--url must use https; got ${parsed.protocol}. Host the tarball over TLS.`;
	}
	const host = parsed.hostname;
	if (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host === "::1" ||
		host.endsWith(".local") ||
		isPrivateIp(host) ||
		isPrivateMappedIPv6(host)
	) {
		return `--url ${url} resolves to a non-public host (${host}); consumers won't be able to install from it. Host the tarball publicly first.`;
	}
	return null;
}

/**
 * Resolve `host` via DNS and check whether any A/AAAA record falls inside
 * the public-host deny list. Used by the redirect loop to defend against
 * a public hostname pointed at a private IP.
 *
 * Best-effort: errors short-circuit to "couldn't resolve, treat as
 * suspicious" so a transient DNS failure during publish doesn't silently
 * succeed against an attacker-controlled redirect chain.
 *
 * Returns an error message or null. Pass an already-validated URL.
 */
async function validateResolvedHost(host: string): Promise<string | null> {
	// Literal IPs are already caught by the syntactic guard. We only resolve
	// hostnames.
	if (IPV4_RE.test(host)) return null;
	if (host.includes(":")) return null; // IPv6 literal in URL form
	const { lookup } = await import("node:dns/promises");
	let addresses: Array<{ address: string; family: number }>;
	try {
		addresses = await lookup(host, { all: true, verbatim: true });
	} catch (error) {
		return `could not resolve ${host}: ${error instanceof Error ? error.message : String(error)}`;
	}
	for (const { address } of addresses) {
		if (
			address === "127.0.0.1" ||
			address === "::1" ||
			isPrivateIp(address) ||
			isPrivateMappedIPv6(address)
		) {
			return `${host} resolves to non-public address ${address}`;
		}
	}
	return null;
}

// Module-scope regexes so we don't re-compile on every call. The IP-literal
// guard is the FIRST line of defence -- the redirect loop additionally runs
// a DNS-resolved check (`validateResolvedHost`) so a public hostname
// pointing at a private IP is also caught.
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
const IPV6_ULA_FC_RE = /^fc[0-9a-f]{2}:/i;
const IPV6_ULA_FD_RE = /^fd[0-9a-f]{2}:/i;
const IPV6_LINK_LOCAL_RE = /^fe[89ab][0-9a-f]:/i;
// IPv4-mapped (::ffff:1.2.3.4) and IPv4-compatible (::1.2.3.4) IPv6.
const IPV6_V4_MAPPED_RE = /^(?:0*:)*(?:ffff:)?(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;

/**
 * Detect RFC 1918, loopback, link-local, CGNAT, and 0.0.0.0/8 IPv4
 * literals. The IPv6 ULA/link-local cases are handled below.
 */
function isPrivateIp(host: string): boolean {
	const v4 = IPV4_RE.exec(host);
	if (v4) {
		const [, aStr, bStr] = v4;
		const a = Number(aStr);
		const b = Number(bStr);
		if (a === 0) return true; // 0.0.0.0/8 ("this network")
		if (a === 10) return true;
		if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64.0.0/10
		if (a === 127) return true;
		if (a === 169 && b === 254) return true; // link-local + cloud metadata
		if (a === 172 && b >= 16 && b <= 31) return true;
		if (a === 192 && b === 168) return true;
	}
	// IPv6 literal in URL form is wrapped in []; URL strips the brackets in
	// `hostname`. ULA fc00::/7 and link-local fe80::/10.
	if (IPV6_ULA_FC_RE.test(host) || IPV6_ULA_FD_RE.test(host)) return true;
	if (IPV6_LINK_LOCAL_RE.test(host)) return true;
	return false;
}

/**
 * IPv4-mapped IPv6 addresses (`::ffff:127.0.0.1`) and IPv4-compatible IPv6
 * (`::127.0.0.1`) tunnel a v4 address through v6 syntax. Without this check
 * a redirect to `https://[::ffff:169.254.169.254]/` would bypass the v4
 * private-IP guard and fetch cloud-instance metadata. Match the embedded
 * v4 address and re-run the v4 check on it.
 */
function isPrivateMappedIPv6(host: string): boolean {
	const m = IPV6_V4_MAPPED_RE.exec(host);
	if (!m) return false;
	const inner = m[1];
	if (!inner) return false;
	return isPrivateIp(inner);
}

/**
 * Catch the user passing an empty-string flag value (`--license=`). citty
 * gives us "" which the publish API treats as missing -- the user gets a
 * confusing PROFILE_BOOTSTRAP_MISSING_FIELD even though they explicitly
 * passed the flag.
 */
function validateStringFlags(flags: Record<string, string | undefined>): string | null {
	for (const [name, value] of Object.entries(flags)) {
		if (value !== undefined && value === "") {
			return `--${name} cannot be empty`;
		}
	}
	return null;
}

/**
 * Fetch the tarball bytes at `url`. We need the full body to compute the
 * checksum and to read `manifest.json` from inside it. Streams the response
 * with a hard cap so a malicious URL can't OOM the CLI.
 *
 * Follows redirects MANUALLY so we can re-validate every hop against
 * `validatePublishUrl`. Without this, a publisher could pass a public URL
 * that 302s to `http://169.254.169.254/...` (cloud metadata) or to a
 * `localhost` victim, defeating the publish-side allow-list.
 */
async function fetchTarball(url: string): Promise<Uint8Array> {
	const MAX_REDIRECTS = 10;
	let currentUrl = url;
	let res: Response | undefined;
	// Run a DNS-level check on the initial URL (validatePublishUrl already
	// passed, but it only catches IP literals -- a public hostname pointing
	// at a private IP slips through the syntactic guard).
	const initialDns = await validateResolvedHost(new URL(url).hostname);
	if (initialDns) {
		throw new Error(`tarball at ${url}: ${initialDns}`);
	}
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		res = await fetch(currentUrl, {
			// GitHub release assets need this header to actually serve the file
			// (without it the API URL returns JSON metadata). Direct CDN URLs
			// ignore the header.
			headers: { Accept: "application/octet-stream" },
			redirect: "manual",
		});
		// `manual` means 3xx responses come back with a Location header rather
		// than being followed. fetch() in workerd / node also surfaces
		// "opaqueredirect" status 0 in some environments; treat any 3xx-ish
		// state (or status 0) WITH a Location header as a redirect.
		const status = res.status;
		const location = res.headers.get("location");
		if (location === null) break;
		const isRedirect = (status >= 300 && status < 400) || status === 0;
		if (!isRedirect) break;
		if (hop === MAX_REDIRECTS) {
			throw new Error(`tarball at ${url}: too many redirects (>${MAX_REDIRECTS})`);
		}
		// Resolve relative Locations against the current URL.
		const next = new URL(location, currentUrl).toString();
		const hopError = validatePublishUrl(next);
		if (hopError) {
			throw new Error(`tarball at ${url} redirected to a disallowed URL (${next}): ${hopError}`);
		}
		// DNS-resolve the hop target to defend against a public hostname
		// that returns a private A/AAAA record (the publishUrl syntactic
		// guard only catches IP literals).
		const dnsError = await validateResolvedHost(new URL(next).hostname);
		if (dnsError) {
			throw new Error(`tarball at ${url} redirected to a disallowed URL (${next}): ${dnsError}`);
		}
		currentUrl = next;
	}
	if (!res) {
		// Loop is structured so this is unreachable, but TS can't see it.
		throw new Error(`failed to fetch ${url}: no response`);
	}
	if (!res.ok) {
		throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
	}

	// If the server told us the size up front, reject oversized responses
	// before reading the body.
	const contentLength = res.headers.get("content-length");
	if (contentLength) {
		const len = Number(contentLength);
		if (Number.isFinite(len) && len > MAX_TARBALL_BYTES) {
			throw new Error(
				`tarball at ${url} is ${formatBytes(len)} which exceeds the ${formatBytes(MAX_TARBALL_BYTES)} limit`,
			);
		}
	}

	if (!res.body) {
		const buf = await res.arrayBuffer();
		if (buf.byteLength > MAX_TARBALL_BYTES) {
			throw new Error(
				`tarball at ${url} is ${formatBytes(buf.byteLength)} which exceeds the ${formatBytes(MAX_TARBALL_BYTES)} limit`,
			);
		}
		return new Uint8Array(buf);
	}

	// Stream the body so we can abort once we exceed the cap, instead of
	// buffering an unbounded response into memory.
	const reader = res.body.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		if (value) {
			total += value.length;
			if (total > MAX_TARBALL_BYTES) {
				await reader.cancel();
				throw new Error(`tarball at ${url} exceeds the ${formatBytes(MAX_TARBALL_BYTES)} limit`);
			}
			chunks.push(value);
		}
	}
	const combined = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		combined.set(chunk, offset);
		offset += chunk.length;
	}
	return combined;
}

/**
 * Extract `manifest.json` from a gzipped tarball, using `modern-tar`'s
 * stream-then-collect API. Returns the parsed-and-validated manifest.
 *
 * Accepts both `manifest.json` and `./manifest.json` since modern-tar's
 * exact naming behaviour isn't pinned in our contract.
 *
 * Validates the parsed JSON shape against the contract before returning,
 * so downstream code (which iterates `capabilities`, indexes `allowedHosts`,
 * etc.) doesn't TypeError on garbage input from a malicious tarball.
 */
async function extractManifestFromTarball(bytes: Uint8Array): Promise<PluginManifest> {
	const { unpackTar, createGzipDecoder } = await import("modern-tar");
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
	let entries;
	try {
		const decoded = source.pipeThrough(createGzipDecoder()) as ReadableStream<Uint8Array>;
		entries = await unpackTar(decoded);
	} catch (error) {
		throw new Error(
			`tarball at the URL is not a valid gzipped tar archive: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	const manifestEntry = entries.find((e) => {
		const name = e.header.name;
		return name === "manifest.json" || name === "./manifest.json";
	});
	if (!manifestEntry?.data) {
		throw new Error("manifest.json not found in tarball");
	}
	let parsed: unknown;
	try {
		parsed = JSON.parse(new TextDecoder().decode(manifestEntry.data));
	} catch (error) {
		throw new Error(
			`manifest.json in the tarball is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
			{ cause: error },
		);
	}
	return assertManifestShape(parsed);
}

/**
 * Validate the structural shape of a parsed `manifest.json` against the
 * contract. Throws a clean error if any required field is missing or
 * mistyped, so downstream code doesn't have to defensively guard every
 * `manifest.foo.bar` access.
 *
 * The manifest contract is the wire shape published in
 * `@emdash-cms/plugin-types`; this guard checks the fields we actively use.
 */
function assertManifestShape(value: unknown): PluginManifest {
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		throw new Error("manifest.json must be a JSON object");
	}
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || v.id.length === 0) {
		throw new Error("manifest.json: `id` must be a non-empty string");
	}
	if (typeof v.version !== "string" || v.version.length === 0) {
		throw new Error("manifest.json: `version` must be a non-empty string");
	}
	if (!Array.isArray(v.capabilities) || v.capabilities.some((c) => typeof c !== "string")) {
		throw new Error("manifest.json: `capabilities` must be an array of strings");
	}
	if (!Array.isArray(v.allowedHosts) || v.allowedHosts.some((h) => typeof h !== "string")) {
		throw new Error("manifest.json: `allowedHosts` must be an array of strings");
	}
	// `typeof null === "object"` and `typeof [] === "object"`, so both checks
	// matter. Same for `admin` below.
	if (!v.storage || typeof v.storage !== "object" || Array.isArray(v.storage)) {
		throw new Error("manifest.json: `storage` must be an object");
	}
	if (!Array.isArray(v.hooks)) {
		throw new Error("manifest.json: `hooks` must be an array");
	}
	for (const [i, entry] of v.hooks.entries()) {
		// Hook entries are either bare hook-name strings or
		// `{ hook: string, ... }` objects per the manifest contract. Anything
		// else means the publisher hand-edited (or corrupted) the manifest.
		if (typeof entry === "string") continue;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(
				`manifest.json: \`hooks[${i}]\` must be a string or object, got ${describeJsonValue(entry)}`,
			);
		}
	}
	if (!Array.isArray(v.routes)) {
		throw new Error("manifest.json: `routes` must be an array");
	}
	for (const [i, entry] of v.routes.entries()) {
		if (typeof entry === "string") continue;
		if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
			throw new Error(
				`manifest.json: \`routes[${i}]\` must be a string or object, got ${describeJsonValue(entry)}`,
			);
		}
	}
	if (!v.admin || typeof v.admin !== "object" || Array.isArray(v.admin)) {
		throw new Error("manifest.json: `admin` must be an object");
	}
	return v as unknown as PluginManifest;
}

/** Shape-describing string for error messages. Distinguishes null/array/object. */
function describeJsonValue(value: unknown): string {
	if (value === null) return "null";
	if (Array.isArray(value)) return "array";
	return typeof value;
}

/**
 * Map a `ProfileBootstrap` field name back to the user-facing CLI flag for
 * warnings. Keeps the API-side names internal-friendly while the CLI surface
 * stays kebab-case.
 */
function profileFieldToFlag(field: string): string {
	const map: Record<string, string> = {
		license: "--license",
		authorName: "--author-name",
		authorUrl: "--author-url",
		authorEmail: "--author-email",
		securityEmail: "--security-email",
		securityUrl: "--security-url",
	};
	return map[field] ?? `--${field}`;
}
