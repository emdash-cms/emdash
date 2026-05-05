/**
 * `emdash-registry publish --url <url>`
 *
 * Thin citty wrapper around `publishRelease` from `../publish/api.js`.
 *
 * Responsibilities here are limited to:
 *   - parsing args and reading filesystem credentials,
 *   - fetching the tarball at `--url` so the API has bytes to work with,
 *   - extracting the manifest from those bytes,
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

import {
	FileCredentialStore,
	PublishingClient,
} from "@emdash-cms/registry-client";
import type { PluginManifest } from "@emdash-cms/plugin-types";
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
				"Optional path to a local copy of the tarball at --url. Skips the download but still verifies the URL serves matching bytes.",
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
		// Fetch + checksum the tarball.
		consola.start(`Fetching ${args.url}...`);
		const tarballBytes = await fetchTarball(args.url);
		const checksum = sha256Multihash(tarballBytes);

		consola.info(`Tarball: ${formatBytes(tarballBytes.length)}`);
		consola.info(`Multihash: ${pc.dim(checksum)}`);

		// Optional local cross-check.
		if (args.local) {
			const localPath = resolve(args.local);
			const localBytes = await readFile(localPath);
			const localChecksum = sha256Multihash(localBytes);
			if (localChecksum !== checksum) {
				consola.error(
					`Local file ${pc.dim(localPath)} does not match the bytes served at ${args.url}.`,
				);
				consola.error(
					`Local multihash:  ${localChecksum}\n` +
						`Remote multihash: ${checksum}\n\n` +
						"Re-upload the correct tarball, or drop --local to publish whatever's at the URL.",
				);
				process.exit(1);
			}
			consola.success(`Local file at ${pc.dim(localPath)} matches the URL`);
		}

		// Extract manifest.json from the tarball.
		consola.start("Reading manifest from tarball...");
		const manifest = await extractManifestFromTarball(tarballBytes);

		// Resume the active publisher session.
		const credentials = new FileCredentialStore();
		const session = await credentials.current();
		if (!session) {
			consola.error("Not logged in. Run: emdash-registry login <handle-or-did>");
			process.exit(1);
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
			...(args["security-email"] !== undefined
				? { securityEmail: args["security-email"] }
				: {}),
			...(args["security-url"] !== undefined ? { securityUrl: args["security-url"] } : {}),
		};

		const logger: PublishLogger = {
			info: (m) => consola.info(m),
			success: (m) => consola.success(m),
			warn: (m) => consola.warn(m),
		};

		try {
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
					`Ignored on subsequent publish (existing profile wins): ${flags}. ` +
						"Profile updates aren't supported yet; edit the record directly via your PDS for now.",
				);
			}

			if (args.json) {
				console.log(
					JSON.stringify({
						profile: result.profileUri,
						release: result.releaseUri,
						cid: result.releaseCid,
						checksum: result.checksum,
						url: args.url,
						profileCreated: result.profileCreated,
						releaseOverwritten: result.releaseOverwritten,
					}),
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
		} catch (error) {
			if (error instanceof PublishError) {
				consola.error(error.message);
				if (error.code === "RELEASE_ALREADY_PUBLISHED") {
					consola.error(
						"To overwrite anyway, pass --allow-overwrite (use only when you're sure no consumers have installed this version yet).",
					);
				}
				process.exit(1);
			}
			throw error;
		}
	},
});

// ── helpers ──────────────────────────────────────────────────────────────────

function formatBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Fetch the tarball bytes at `url`. We need the full body to compute the
 * checksum and to read `manifest.json` from inside it.
 */
async function fetchTarball(url: string): Promise<Uint8Array> {
	const res = await fetch(url, {
		// GitHub release assets need this header to actually serve the file
		// (without it the API URL returns JSON metadata). Direct CDN URLs
		// ignore the header.
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
	const decoded = source.pipeThrough(createGzipDecoder()) as ReadableStream<Uint8Array>;
	const entries = await unpackTar(decoded);
	const manifestEntry = entries.find((e) => e.header.name === "manifest.json");
	if (!manifestEntry?.data) {
		throw new Error("manifest.json not found in tarball");
	}
	return JSON.parse(new TextDecoder().decode(manifestEntry.data)) as PluginManifest;
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
