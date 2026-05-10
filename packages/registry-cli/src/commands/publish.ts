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

import { lookup as dnsLookup } from "node:dns/promises";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import type { PluginManifest } from "@emdash-cms/plugin-types";
import { FileCredentialStore, PublishingClient } from "@emdash-cms/registry-client";
import { defineCommand } from "citty";
import consola from "consola";
import pc from "picocolors";

import { formatBytes, MAX_BUNDLE_SIZE, validateBundleSize } from "../bundle/utils.js";
import { sha256Multihash } from "../multihash.js";
import { resumeSession } from "../oauth.js";
import {
	PublishError,
	publishRelease,
	type ProfileBootstrap,
	type PublishLogger,
} from "../publish/api.js";

/**
 * Hard cap on the gzipped tarball we'll buffer into memory. Sized for the
 * decompressed bundle cap from RFC 0001 (MAX_BUNDLE_SIZE = 256 KB) plus
 * tar headers and worst-case gzip overhead. Anything larger is rejected at
 * fetch time before decompression. The decompressed bundle is then re-checked
 * against the per-file and total caps via `validateBundleSize`.
 */
const MAX_TARBALL_BYTES = 384 * 1024;

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
			description:
				"Emit a single-line JSON object on stdout instead of human output. Success: {profile, release, cid, checksum, url, profileCreated, releaseOverwritten}. Failure: {error: {code, message}}. Human-readable progress goes to stderr in either mode.",
		},
	},
	async run({ args }) {
		// In --json mode, stdout MUST contain only the final JSON object so
		// callers can `emdash-registry publish ... --json | jq`. Route every
		// consola log line to stderr; capture the previous reporter set so we
		// can restore in the finally below (matters when the CLI is exec'd
		// in-process by tests or wrappers).
		const restoreReporters = args.json ? redirectConsolaToStderr() : null;
		// `process.exit` inside a catch block runs SYNCHRONOUSLY and skips
		// the finally. Capture the desired exit code, run finally, then
		// exit. The exit code mirrors the originating CliError where
		// available (so user-error vs publish-failure is distinguishable in
		// scripts) and falls back to 1 for anything else.
		let exitCode = 0;
		try {
			await runPublish(args);
		} catch (error) {
			exitCode = error instanceof CliError ? error.exitCode : 1;
			handlePublishError(error, args.json);
		} finally {
			restoreReporters?.();
		}
		if (exitCode !== 0) process.exit(exitCode);
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
	consola.info(`Publishing as ${pc.bold(session.handle ?? session.did)} (${pc.dim(session.did)})`);

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
	console.log(
		`  ${pc.cyan(`emdash-registry info ${session.handle ?? session.did} ${result.slug}`)}`,
	);
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

/**
 * Validate the publish URL before any network access. Returns an error message
 * to print, or `null` if the URL is acceptable.
 *
 * The CLI runs locally so the SSRF surface is the publisher's own machine,
 * not a server. The real harm is publishing a record pointing at a
 * non-public URL: consumers can't install from `file:///` or `http://192.x`
 * and end up with a broken record in the registry. We reject those up front.
 */
// Exported for unit tests; not part of the public CLI surface.
export function validatePublishUrlForTest(url: string): string | null {
	return validatePublishUrl(url);
}

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
	// `URL.hostname` keeps the `[ ]` around IPv6 literals AND normalises any
	// embedded IPv4 dotted-quad to two hex groups (e.g.
	// `::ffff:169.254.169.254` -> `[::ffff:a9fe:a9fe]`). Strip brackets
	// before any check; downstream helpers operate on the bracket-free form.
	// Also strip a single trailing dot (FQDN form): mDNS resolvers happily
	// resolve both `mymachine.local` and `mymachine.local.`, so the
	// `.local` deny check has to canonicalise both.
	const host = stripTrailingDot(stripIPv6Brackets(parsed.hostname));
	if (host.length === 0) {
		return `--url ${url} has an empty hostname after canonicalisation`;
	}
	if (
		host === "localhost" ||
		host === "127.0.0.1" ||
		host === "::1" ||
		host.endsWith(".local") ||
		isPrivateIp(host) ||
		isPrivateMappedIPv6(host) ||
		isPrivateIPv6Literal(host)
	) {
		return `--url ${url} resolves to a non-public host (${host}); consumers won't be able to install from it. Host the tarball publicly first.`;
	}
	return null;
}

/**
 * Strip a single trailing dot from a DNS name (FQDN form). Idempotent.
 * Real hostnames don't end with multiple dots after URL parsing, so we
 * only strip one.
 */
function stripTrailingDot(host: string): string {
	if (host.endsWith(".")) return host.slice(0, -1);
	return host;
}

/**
 * Remove the surrounding brackets that `URL.hostname` keeps around an IPv6
 * literal. Returns the input unchanged if not bracketed.
 */
function stripIPv6Brackets(host: string): string {
	if (host.length >= 2 && host.startsWith("[") && host.endsWith("]")) {
		return host.slice(1, -1);
	}
	return host;
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
	// Literal IPs are caught by `validatePublishUrl`'s syntactic guard
	// (which is invariably called immediately before this in both the
	// initial-URL and redirect-hop paths). We skip resolving them here:
	//   - v4 literal: matches IPV4_RE, no DNS to do.
	//   - v6 literal: contains `:`, no DNS to do (URL keeps brackets in
	//     hostname; the bracket form has `:` so the include check fires).
	// Real hostnames contain neither; that's what we resolve.
	//
	// CAVEAT (DNS rebinding): the OS resolver may cache for a TTL the
	// attacker controls. A 1-second TTL means the validation lookup and
	// the subsequent `fetch` lookup can resolve to different addresses.
	// A motivated attacker can return a public IP for the validation
	// lookup and a private IP for the fetch. Mitigating this fully
	// requires resolving once and binding the connection to the resolved
	// IP literal, which means giving up SNI / Host-header convenience.
	// We accept the residual risk for the publish CLI (run by a human
	// publishing their own content) and document it here so it isn't
	// surprising.
	const stripped = stripIPv6Brackets(host);
	if (IPV4_RE.test(stripped)) return null;
	if (stripped.includes(":")) return null;
	let addresses: Array<{ address: string; family: number }>;
	try {
		addresses = await dnsLookup(stripped, { all: true, verbatim: true });
	} catch (error) {
		return `could not resolve ${stripped}: ${error instanceof Error ? error.message : String(error)}`;
	}
	for (const { address } of addresses) {
		if (
			address === "127.0.0.1" ||
			address === "::1" ||
			isPrivateIp(address) ||
			isPrivateMappedIPv6(address) ||
			isPrivateIPv6Literal(address)
		) {
			return `${stripped} resolves to non-public address ${address}`;
		}
	}
	return null;
}

// Module-scope regexes so we don't re-compile on every call. The IP-literal
// guard is the FIRST line of defence -- the redirect loop additionally runs
// a DNS-resolved check (`validateResolvedHost`) so a public hostname
// pointing at a private IP is also caught.
const TAR_LEADING_DOT_SLASH_RE = /^\.\//;
const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
// IPv6 ULA (fc00::/7), link-local (fe80::/10). Bracket-stripped form.
const IPV6_ULA_FC_RE = /^fc[0-9a-f]{2}(?::|$)/i;
const IPV6_ULA_FD_RE = /^fd[0-9a-f]{2}(?::|$)/i;
const IPV6_LINK_LOCAL_RE = /^fe[89ab][0-9a-f](?::|$)/i;
// Loopback (::1), unspecified (::) -- already special-cased in
// `validatePublishUrl` for clarity, also caught here. Bracket-stripped.
const IPV6_LOOPBACK_RE = /^::1$/i;
const IPV6_UNSPECIFIED_RE = /^::$/i;
// IPv4-compatible IPv6 (`::a.b.c.d`, deprecated but valid input form).
const IPV6_V4_COMPAT_DOTTED_RE = /^::(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;
// IPv4-mapped IPv6 in dotted form (`::ffff:a.b.c.d`).
const IPV6_V4_MAPPED_DOTTED_RE = /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/i;
// IPv4-mapped IPv6 after URL parser normalisation (`::ffff:hhhh:hhhh`).
// Two hex groups of up to 4 chars each, encoding 4 octets of v4. The URL
// parser collapses leading zero groups into `::` and converts the IPv4
// suffix into hex pairs.
const IPV6_V4_MAPPED_HEX_RE = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
// IPv4-compatible IPv6 after URL parser normalisation. The dotted form
// `::a.b.c.d` is normalised by Node's URL parser to `::hhhh:hhhh` (no
// `ffff:` prefix) -- without this branch, the IPv4-compat case slips
// through both the dotted regex (because the URL parser ate the dots)
// and the v4-mapped-hex regex (because there's no `ffff:`).
const IPV6_V4_COMPAT_HEX_RE = /^::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
// IPv6 prefixes that carry an embedded IPv4 in their last 32 bits. We
// enumerate explicitly rather than treating EVERY v6 literal's trailing
// 32 bits as a candidate v4 -- the broader form would false-positive
// reject legitimate public v6 addresses whose last two hex groups
// coincidentally encode an RFC1918 / loopback / 169.254 octet pattern.
//
// Currently covered:
//   - `64:ff9b::/96`        — RFC 6052 NAT64 well-known prefix
//   - `64:ff9b:1::/48`      — RFC 8215 NAT64 local-use prefix
//   - `2002:xxxx:xxxx::/16` — 6to4 (xxxx:xxxx encodes the v4)
//   - `::/96`               — IPv4-compatible (already handled by
//                             IPV6_V4_COMPAT_DOTTED_RE for dotted form)
const IPV6_NAT64_RE = /^64:ff9b::([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
// RFC 8215 local-use NAT64 prefix `64:ff9b:1::/48`. The URL parser
// collapses runs of zero groups into `::`, so the typical form for this
// prefix when carrying a v4 in the last 32 bits is
// `64:ff9b:1::WWWW:XXXX`. Match the prefix permissively and capture the
// trailing two hex groups.
const IPV6_NAT64_LOCAL_RE = /^64:ff9b:1:[0-9a-f:]*:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i;
const IPV6_6TO4_RE = /^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/i;

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
 * IPv4-mapped (`::ffff:1.2.3.4`) and IPv4-compatible (`::1.2.3.4`) IPv6.
 *
 * Note: Node's `URL` parser normalises the dotted-quad form to hex pairs
 * (`::ffff:a9fe:a9fe`), so for inputs that came through `URL.hostname` we
 * also need the hex-pair branch. We handle both because `validatePublishUrl`
 * is also called with redirect Locations that may not have been re-parsed.
 */
function isPrivateMappedIPv6(host: string): boolean {
	const dotted = IPV6_V4_MAPPED_DOTTED_RE.exec(host) ?? IPV6_V4_COMPAT_DOTTED_RE.exec(host);
	if (dotted) {
		const inner = dotted[1];
		return inner ? isPrivateIp(inner) : false;
	}
	const hex = IPV6_V4_MAPPED_HEX_RE.exec(host) ?? IPV6_V4_COMPAT_HEX_RE.exec(host);
	if (hex) {
		const v4 = decodeIPv6V4HexPair(hex[1], hex[2]);
		return v4 ? isPrivateIp(v4) : false;
	}
	return false;
}

/**
 * Detect a private IPv6 address literal in bracket-stripped form. Covers
 * loopback `::1`, unspecified `::`, ULA `fc00::/7`, link-local `fe80::/10`,
 * and any literal whose final 32 bits decode to a private IPv4 (handles
 * NAT64 well-known-prefix `64:ff9b::a.b.c.d` style addresses where the
 * URL parser has converted the dotted suffix to hex).
 */
function isPrivateIPv6Literal(host: string): boolean {
	if (IPV6_LOOPBACK_RE.test(host)) return true;
	if (IPV6_UNSPECIFIED_RE.test(host)) return true;
	if (IPV6_ULA_FC_RE.test(host)) return true;
	if (IPV6_ULA_FD_RE.test(host)) return true;
	if (IPV6_LINK_LOCAL_RE.test(host)) return true;
	// NAT64 (`64:ff9b::a.b.c.d` -> URL-normalised to
	// `64:ff9b::aabb:ccdd`). Decode the embedded v4 and re-check.
	const nat64 = IPV6_NAT64_RE.exec(host) ?? IPV6_NAT64_LOCAL_RE.exec(host);
	if (nat64) {
		const v4 = decodeIPv6V4HexPair(nat64[1], nat64[2]);
		if (v4 && isPrivateIp(v4)) return true;
	}
	// 6to4 (`2002:WWXX:YYZZ::/48` where WWXX:YYZZ is the v4). The v4 is at
	// the prefix, not the suffix.
	const sixtofour = IPV6_6TO4_RE.exec(host);
	if (sixtofour) {
		const v4 = decodeIPv6V4HexPair(sixtofour[1], sixtofour[2]);
		if (v4 && isPrivateIp(v4)) return true;
	}
	return false;
}

/**
 * Decode two IPv6 hex groups (each up to 4 hex digits) into an IPv4 dotted
 * quad. Returns null if either group is out of range. Matches the encoding
 * Node's `URL` parser uses when an IPv6 literal includes a dotted IPv4
 * suffix.
 */
function decodeIPv6V4HexPair(a: string | undefined, b: string | undefined): string | null {
	if (!a || !b) return null;
	const ax = Number.parseInt(a, 16);
	const bx = Number.parseInt(b, 16);
	if (!Number.isFinite(ax) || !Number.isFinite(bx)) return null;
	if (ax < 0 || ax > 0xffff || bx < 0 || bx > 0xffff) return null;
	const o1 = (ax >> 8) & 0xff;
	const o2 = ax & 0xff;
	const o3 = (bx >> 8) & 0xff;
	const o4 = bx & 0xff;
	return `${o1}.${o2}.${o3}.${o4}`;
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
/**
 * Build the error message for the gzipped-fetch cap. The cap itself is an
 * implementation detail of the fetch buffer (sized to fit any bundle that
 * meets the published RFC 0001 caps); the user-facing constraint is the
 * decompressed total — surface that here so the next attempt aims at the
 * right number.
 */
function oversizedFetchError(url: string, fetched: number): string {
	return (
		`tarball at ${url} is ${formatBytes(fetched)} (gzipped), exceeding the ${formatBytes(MAX_TARBALL_BYTES)} fetch cap. ` +
		`Sandboxed plugin bundles must decompress to at most ${formatBytes(MAX_BUNDLE_SIZE)} (RFC 0001).`
	);
}

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
			throw new Error(oversizedFetchError(url, len));
		}
	}

	if (!res.body) {
		const buf = await res.arrayBuffer();
		if (buf.byteLength > MAX_TARBALL_BYTES) {
			throw new Error(oversizedFetchError(url, buf.byteLength));
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
				throw new Error(oversizedFetchError(url, total));
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
 * Enforces the bundle size caps from RFC 0001 against the decompressed
 * entries — total decompressed size, per-file size, and file count. The
 * gzipped fetch is already capped at MAX_TARBALL_BYTES upstream; this is
 * the post-decompression check that matches what aggregators enforce at
 * ingest, so a publisher who would be rejected at the registry sees the
 * same error locally first.
 *
 * Validates the parsed JSON shape against the contract before returning,
 * so downstream code (which iterates `capabilities`, indexes `allowedHosts`,
 * etc.) doesn't TypeError on garbage input from a malicious tarball.
 */
// Exported for unit tests; not part of the public CLI surface.
export const extractManifestFromTarballForTest = extractManifestFromTarball;

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
	// The bundle size caps apply to regular files only: directories,
	// symlinks, hardlinks, devices, and FIFOs all carry no content and
	// shouldn't appear in a sandboxed plugin bundle anyway. Filtering by
	// header.type matches what `collectBundleEntries` does for the staging
	// dir (where `item.isFile()` already excludes non-files), so the bundle
	// command and the publish command agree on what counts.
	const fileEntries = entries
		.filter((e) => (e.header.type ?? "file") === "file")
		.map((e) => ({
			name: e.header.name.replace(TAR_LEADING_DOT_SLASH_RE, ""),
			bytes: e.data?.byteLength ?? 0,
		}));
	const sizeViolations = validateBundleSize(fileEntries);
	if (sizeViolations.length > 0) {
		throw new Error(
			`tarball at the URL violates bundle size caps:\n  - ${sizeViolations.join("\n  - ")}`,
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
 * Best-effort structural sanity check on a parsed `manifest.json`. NOT a
 * full lexicon validation: we check the shapes the publish flow actually
 * touches (`id`, `version`, `capabilities`, `allowedHosts`, plus that
 * `storage`/`hooks`/`routes`/`admin` are at least the right top-level
 * shape). Hook and route entries are only checked to be string-or-object;
 * we deliberately don't validate their inner structure here because (a)
 * the publish flow doesn't iterate them and (b) the inner shape varies
 * across manifest schema versions and is core's read-side problem.
 *
 * Callers who need a full validation should round-trip through the runtime
 * narrowing helper in `packages/core/src/plugins/manifest-schema.ts`.
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
