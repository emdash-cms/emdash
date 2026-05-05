/**
 * `emdash-registry publish --tarball <path> --url <url>`
 *
 * Publish a release of a sandboxed plugin to the registry.
 *
 * Phase 1 flow:
 *
 *   1. Read the tarball at `--tarball <path>` and compute its sha2-256
 *      multibase-multihash. (For now the tarball is required as input;
 *      bundling on the fly is a follow-up that wires this command into the
 *      `bundle` subcommand.)
 *   2. Extract `manifest.json` from the tarball to read `id` and `version`.
 *   3. Resume the active publisher session (errors if not logged in).
 *   4. If no `package.profile` record exists for the slug, bootstrap one
 *      from manifest data + flag-supplied identity fields. Otherwise leave
 *      the existing profile alone.
 *   5. `putRecord` a `package.release` record at rkey `<slug>:<version>`
 *      pointing `artifacts.package` at `--url` with the computed checksum.
 *
 * The author is responsible for hosting the tarball at `--url` (GitHub
 * release asset, R2, S3, the author's own server -- per the RFC). The
 * aggregator may mirror it; the publisher is the source of truth.
 *
 * Hard-failed conditions:
 *   - Manifest declares deprecated capabilities. Bundle warns; publish
 *     refuses, per the deprecation policy.
 *   - `--url` is not reachable, or the body's checksum doesn't match the
 *     computed local checksum. Belt-and-braces: the aggregator will check
 *     this too, but a fail-fast at publish time gives a clearer error.
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { ClientResponseError } from "@atcute/client";
import {
	FileCredentialStore,
	PublishingClient,
	type PublisherSession,
} from "@emdash-cms/registry-client";
import { NSID } from "@emdash-cms/registry-lexicons";
import { defineCommand } from "citty";
import consola from "consola";
import pc from "picocolors";

import { CAPABILITY_RENAMES, isDeprecatedCapability } from "../bundle/types.js";
import type { PluginManifest } from "../bundle/types.js";
import { sha256Multihash } from "../multihash.js";
import { resumeSession } from "../oauth.js";

interface PackageProfileRecord {
	$type: string;
	id: string;
	type: string;
	license: string;
	authors: Array<{ name: string; url?: string; email?: string }>;
	security: Array<{ url?: string; email?: string }>;
	slug?: string;
	name?: string;
	description?: string;
	keywords?: string[];
	lastUpdated?: string;
}

interface PackageReleaseRecord {
	$type: string;
	package: string;
	version: string;
	artifacts: {
		package: {
			url: string;
			checksum: string;
			contentType?: string;
		};
	};
}

export const publishCommand = defineCommand({
	meta: {
		name: "publish",
		description:
			"Publish a sandboxed plugin release to the registry (atproto + FAIR-shaped records)",
	},
	args: {
		tarball: {
			type: "string",
			description: "Path to the bundled plugin tarball (run `emdash-registry bundle` first)",
			required: true,
		},
		url: {
			type: "string",
			description: "Public URL where the tarball is hosted (artifact source-of-truth)",
			required: true,
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
		json: {
			type: "boolean",
			description: "Output result as JSON",
		},
	},
	async run({ args }) {
		// ── 1. Read the tarball, compute checksum ──
		const tarballPath = resolve(args.tarball);
		const tarballBytes = await readFile(tarballPath);
		const checksum = sha256Multihash(tarballBytes);
		const sha256Hex = createHash("sha256").update(tarballBytes).digest("hex");

		consola.info(`Tarball: ${pc.dim(tarballPath)} (${formatBytes(tarballBytes.length)})`);
		consola.info(`SHA-256: ${pc.dim(sha256Hex)}`);
		consola.info(`Multihash: ${pc.dim(checksum)}`);

		// ── 2. Extract manifest.json from the tarball ──
		consola.start("Reading manifest from tarball...");
		const manifest = await extractManifestFromTarball(tarballBytes);

		// Hard-fail on deprecated capabilities at publish time.
		const deprecated = manifest.capabilities.filter(isDeprecatedCapability);
		if (deprecated.length > 0) {
			consola.error("Plugin uses deprecated capability names. Rename them before publishing:");
			for (const cap of deprecated) {
				consola.error(`  ${cap} -> ${CAPABILITY_RENAMES[cap]}`);
			}
			process.exit(1);
		}

		// ── 3. Resume the active publisher session ──
		const credentials = new FileCredentialStore();
		const session = await credentials.current();
		if (!session) {
			consola.error("Not logged in. Run: emdash-registry login <handle-or-did>");
			process.exit(1);
		}

		consola.info(`Publishing as ${pc.bold(session.handle)} (${pc.dim(session.did)})`);

		// ── 4. Verify the tarball at --url matches the local checksum ──
		consola.start(`Verifying ${args.url}...`);
		const remote = await fetchTarball(args.url);
		const remoteHex = createHash("sha256").update(remote).digest("hex");
		if (remoteHex !== sha256Hex) {
			consola.error(
				`Tarball at ${args.url} does not match the local file. ` +
					`Local sha256=${sha256Hex.slice(0, 16)}..., remote=${remoteHex.slice(0, 16)}...`,
			);
			consola.error("Re-upload the tarball or pass the correct --url before publishing.");
			process.exit(1);
		}
		consola.success("Remote tarball matches local checksum");

		// ── 5. Open an authenticated publishing client ──
		const oauthSession = await resumeSession(session.did);
		const publisher = PublishingClient.fromHandler({
			handler: oauthSession,
			did: session.did,
			pds: session.pds,
		});

		// ── 6. Bootstrap or reuse the package.profile record ──
		const slug = sanitiseSlug(manifest.id);
		const existingProfile = await getExistingProfile(publisher, slug);
		const profileUri = atUri(session.did, NSID.packageProfile, slug);

		if (existingProfile) {
			consola.info(`Reusing existing profile: ${pc.dim(profileUri)}`);
		} else {
			consola.start(`Creating profile record for ${slug}...`);
			const profile = buildProfileRecord({
				slug,
				profileUri,
				manifest,
				license: args.license,
				authorName: args["author-name"],
				authorUrl: args["author-url"],
				authorEmail: args["author-email"],
				securityEmail: args["security-email"],
				securityUrl: args["security-url"],
			});
			const result = await publisher.putRecord({
				collection: NSID.packageProfile,
				rkey: slug,
				record: profile as unknown as Record<string, unknown>,
			});
			consola.success(`Created profile: ${pc.dim(result.uri)}`);
		}

		// ── 7. Put the package.release record ──
		const rkey = `${slug}:${manifest.version}`;
		const release: PackageReleaseRecord = {
			$type: NSID.packageRelease,
			package: slug,
			version: manifest.version,
			artifacts: {
				package: {
					url: args.url,
					checksum,
					contentType: "application/gzip",
				},
			},
		};

		consola.start(`Publishing release ${slug}@${manifest.version}...`);
		const releaseResult = await publisher.putRecord({
			collection: NSID.packageRelease,
			rkey,
			record: release as unknown as Record<string, unknown>,
		});

		if (args.json) {
			console.log(
				JSON.stringify({
					profile: profileUri,
					release: releaseResult.uri,
					cid: releaseResult.cid,
					checksum,
					url: args.url,
				}),
			);
			return;
		}

		consola.success(`Published ${pc.bold(`${slug}@${manifest.version}`)}`);
		consola.info(`Release URI: ${pc.dim(releaseResult.uri)}`);
		consola.info(`Profile URI: ${pc.dim(profileUri)}`);
		console.log();
		consola.info(
			`The aggregator will pick this up from the firehose. To verify discovery once it's indexed:`,
		);
		console.log(`  ${pc.cyan(`emdash-registry info ${session.handle} ${slug}`)}`);
	},
});

// ── helpers ──────────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

const SLASH_RE = /\//g;
const LEADING_AT_RE = /^@/;

/**
 * Convert a plugin id (which may be a scoped npm name like
 * `@emdash-cms/sandboxed-test`) into a slug suitable for an atproto rkey.
 * Strips the leading `@` and replaces `/` with `-`.
 *
 * The lexicon validates `^[a-z][a-z0-9_-]*$` and a 64-char limit; we don't
 * enforce all of that here -- atproto rejects the putRecord with a clear
 * error if it doesn't match -- but we do the mechanical translation.
 */
function sanitiseSlug(id: string): string {
	return id.replace(LEADING_AT_RE, "").replace(SLASH_RE, "-");
}

function atUri(did: PublisherSession["did"], collection: string, rkey: string): string {
	return `at://${did}/${collection}/${rkey}`;
}

/**
 * Best-effort fetch of the tarball at `url`. We need the bytes to verify the
 * checksum; range requests aren't worth the complexity since publish is
 * one-shot per release.
 */
async function fetchTarball(url: string): Promise<Uint8Array> {
	const res = await fetch(url, {
		// GitHub release assets serve with this content-type when accessed
		// via the API URL; ordinary URLs ignore the header.
		headers: { Accept: "application/octet-stream" },
	});
	if (!res.ok) {
		throw new Error(`failed to fetch ${url}: ${res.status} ${res.statusText}`);
	}
	const buf = await res.arrayBuffer();
	return new Uint8Array(buf);
}

/**
 * Extract `manifest.json` from a gzipped tarball, using `modern-tar`'s
 * stream-then-collect API. Returns the parsed manifest.
 */
async function extractManifestFromTarball(bytes: Uint8Array): Promise<PluginManifest> {
	const { unpackTar, createGzipDecoder } = await import("modern-tar");
	const source = new ReadableStream<Uint8Array>({
		start(controller) {
			controller.enqueue(bytes);
			controller.close();
		},
	});
	// modern-tar's createGzipDecoder is a `ReadableWritablePair<Uint8Array, Uint8Array>`;
	// piping a Uint8Array source through it yields a ReadableStream<Uint8Array>.
	const decoded = source.pipeThrough(createGzipDecoder()) as ReadableStream<Uint8Array>;
	const entries = await unpackTar(decoded);
	const manifestEntry = entries.find((e) => e.header.name === "manifest.json");
	if (!manifestEntry?.data) {
		throw new Error("manifest.json not found in tarball");
	}
	return JSON.parse(new TextDecoder().decode(manifestEntry.data)) as PluginManifest;
}

/**
 * Returns the existing profile record value if one is already in the
 * publisher's repo, or `null` if not.
 */
async function getExistingProfile(publisher: PublishingClient, slug: string): Promise<unknown> {
	try {
		const record = await publisher.getRecord({
			collection: NSID.packageProfile,
			rkey: slug,
		});
		return record.value;
	} catch (error) {
		// `getRecord` throws ClientResponseError with `RecordNotFound` for
		// missing records; treat that as "no profile yet". Anything else we
		// re-throw because it indicates a real failure (auth, network).
		if (error instanceof ClientResponseError && error.error === "RecordNotFound") {
			return null;
		}
		throw error;
	}
}

interface BuildProfileInput {
	slug: string;
	profileUri: string;
	manifest: PluginManifest;
	license: string | undefined;
	authorName: string | undefined;
	authorUrl: string | undefined;
	authorEmail: string | undefined;
	securityEmail: string | undefined;
	securityUrl: string | undefined;
}

function buildProfileRecord(input: BuildProfileInput): PackageProfileRecord {
	if (!input.license) {
		throw new ProfileBootstrapError(
			"--license is required on first publish (e.g. --license MIT). " +
				"The lexicon requires a SPDX license expression for every package.",
		);
	}
	if (!input.securityEmail && !input.securityUrl) {
		throw new ProfileBootstrapError(
			"--security-email or --security-url is required on first publish. " +
				"Clients refuse to install packages without a security contact.",
		);
	}

	const author: { name: string; url?: string; email?: string } = {
		name: input.authorName ?? "unknown",
	};
	if (input.authorUrl) author.url = input.authorUrl;
	if (input.authorEmail) author.email = input.authorEmail;

	const securityContact: { url?: string; email?: string } = {};
	if (input.securityEmail) securityContact.email = input.securityEmail;
	if (input.securityUrl) securityContact.url = input.securityUrl;

	return {
		$type: NSID.packageProfile,
		id: input.profileUri,
		type: "emdash-plugin",
		license: input.license,
		authors: [author],
		security: [securityContact],
		slug: input.slug,
		lastUpdated: new Date().toISOString(),
	};
}

class ProfileBootstrapError extends Error {
	constructor(message: string) {
		super(message);
		this.name = "ProfileBootstrapError";
	}
}
