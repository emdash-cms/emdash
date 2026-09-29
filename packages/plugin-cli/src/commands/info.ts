/**
 * `emdash-plugin info <handle-or-did> <slug>`
 *
 * Show details about a single package. Read-only; no auth required.
 *
 * The first positional argument can be either a handle (`alice.example.com`)
 * or a DID (`did:plc:abc...`). The aggregator distinguishes via separate XRPC
 * methods -- handle goes through `resolvePackage` (which does the
 * handle-to-DID lookup server-side), DID goes straight to `getPackage`.
 */

import { ClientResponseError } from "@atcute/client";
import { isDid, isHandle } from "@atcute/lexicons/syntax";
import { DiscoveryClient } from "@emdash-cms/registry-client";
import { NSID } from "@emdash-cms/registry-lexicons";
import { defineCommand } from "citty";
import { consola } from "consola";
import pc from "picocolors";

import { resolveAggregatorUrl, resolveLabelerUrl } from "../config.js";
import {
	getLatestListingAssessment,
	listingStatusMessage,
	type ListingAssessment,
} from "../listing-status.js";
import { resolveHandleToDid } from "../manifest/publisher.js";
import { formatPackageIdentifier, pluginPageUrl } from "../package-identifier.js";

const WATCH_INTERVAL_MS = 5_000;
const WATCH_TIMEOUT_MS = 10 * 60 * 1_000;

export const infoCommand = defineCommand({
	meta: {
		name: "info",
		description: "Show details about a single package",
	},
	args: {
		publisher: {
			type: "positional",
			description: "Publisher handle (e.g. alice.example.com) or DID",
			required: true,
		},
		slug: {
			type: "positional",
			description: "Package slug",
			required: true,
		},
		"registry-url": {
			type: "string",
			description: "Override registry URL",
		},
		"labeler-url": {
			type: "string",
			description: "Override listing-check service URL",
		},
		version: {
			type: "string",
			description: "Track listing checks for a specific release version",
		},
		watch: {
			type: "boolean",
			description: "Watch listing checks until the package is public or needs attention",
			default: false,
		},
		json: {
			type: "boolean",
			description: "Output as JSON",
		},
	},
	async run({ args }) {
		const aggregatorUrl = resolveAggregatorUrl(args["registry-url"]);
		const labelerUrl = resolveLabelerUrl(args["labeler-url"]);
		const client = new DiscoveryClient({ aggregatorUrl });
		const publisher = args.publisher.startsWith("@") ? args.publisher.slice(1) : args.publisher;
		if (!isDid(publisher) && !isHandle(publisher)) {
			consola.error(
				`"${args.publisher}" is not a valid handle or DID. Expected a handle like "alice.example.com" or a DID like "did:plc:abc123..."`,
			);
			process.exit(2);
		}

		const publisherDid = isDid(publisher) ? publisher : await resolveHandleToDid(publisher);
		const identifier = formatPackageIdentifier(publisher, args.slug);
		const pageUrl = isHandle(publisher) ? pluginPageUrl(publisher, args.slug) : null;
		const deadline = Date.now() + WATCH_TIMEOUT_MS;
		let previousStatus = "";

		for (;;) {
			const result = await lookupPackage(client, publisher, args.slug);
			const releaseVisible =
				result && args.version
					? await hasVisibleReleaseForInfo(args.version, (cursor) =>
							client.listReleases({
								did: result.did,
								package: result.slug,
								limit: 100,
								...(cursor === undefined ? {} : { cursor }),
							}),
						)
					: result !== null;
			if (result && releaseVisible) {
				await printPackageInfo(client, result, args.json === true);
				return;
			}

			const status = await readListingStatus(labelerUrl, publisherDid, args.slug, args.version);
			if (args.json) {
				console.log(
					JSON.stringify(
						{
							identifier,
							public: false,
							profile: status.profile,
							...(status.release === undefined ? {} : { release: status.release }),
							...(pageUrl === null ? {} : { page: pageUrl }),
						},
						null,
						2,
					),
				);
				return;
			}

			const statusKey = JSON.stringify(status);
			if (statusKey !== previousStatus) {
				printListingStatus(identifier, args.version, pageUrl, status);
				previousStatus = statusKey;
			}
			if (!args.watch || listingNeedsAttention(status) || Date.now() >= deadline) {
				if (args.watch && Date.now() >= deadline) {
					consola.info("Still waiting. Run the same command later to continue checking.");
				}
				return;
			}
			await new Promise((resolve) => setTimeout(resolve, WATCH_INTERVAL_MS));
		}
	},
});

type PackageView = Awaited<ReturnType<DiscoveryClient["getPackage"]>>;

async function lookupPackage(
	client: DiscoveryClient,
	publisher: string,
	slug: string,
): Promise<PackageView | null> {
	try {
		if (isDid(publisher)) return await client.getPackage({ did: publisher, slug });
		if (isHandle(publisher)) return await client.resolvePackage({ handle: publisher, slug });
		throw new TypeError("publisher must be a handle or DID");
	} catch (error) {
		if (
			error instanceof ClientResponseError &&
			(error.error === "ListingUnavailable" || error.error === "NotFound")
		) {
			return null;
		}
		throw error;
	}
}

interface PackageListingStatus {
	profile: ListingAssessment | null;
	release?: ListingAssessment | null;
}

async function readListingStatus(
	labelerUrl: string,
	publisherDid: string,
	slug: string,
	version: string | undefined,
): Promise<PackageListingStatus> {
	const profileUri = `at://${publisherDid}/${NSID.packageProfile}/${slug}`;
	const releaseUri = version
		? `at://${publisherDid}/${NSID.packageRelease}/${slug}:${version}`
		: null;
	const [profile, release] = await Promise.all([
		getLatestListingAssessment({ labelerUrl, kind: "profile", uri: profileUri }),
		releaseUri
			? getLatestListingAssessment({ labelerUrl, kind: "release", uri: releaseUri })
			: undefined,
	]);
	return { profile, ...(release === undefined ? {} : { release }) };
}

function printListingStatus(
	identifier: string,
	version: string | undefined,
	pageUrl: string | null,
	status: PackageListingStatus,
): void {
	console.log();
	console.log(pc.bold(identifier));
	console.log(`  Public listing: not available`);
	console.log(`  ${listingStatusMessage("Package details", status.profile)}`);
	if (version) {
		console.log(`  ${listingStatusMessage(`Release ${version}`, status.release ?? null)}`);
	}
	if (pageUrl) console.log(`  Public page after approval: ${pc.dim(pageUrl)}`);
	console.log();
	consola.info("Unapproved package details are not returned by the registry.");
}

function listingNeedsAttention(status: PackageListingStatus): boolean {
	return [status.profile, status.release].some(
		(assessment) =>
			assessment?.state === "blocked" ||
			assessment?.state === "error" ||
			assessment?.state === "review",
	);
}

async function printPackageInfo(
	client: DiscoveryClient,
	result: PackageView,
	json: boolean,
): Promise<void> {
	const latestRelease = await getLatestReleaseForInfo(result.latestVersion, () =>
		client.getLatestRelease({ did: result.did, package: result.slug }),
	);
	const hosting = hostingMode(latestRelease?.release?.artifacts.package);

	if (json) {
		console.log(JSON.stringify({ ...result, latestRelease, hosting }, null, 2));
		return;
	}

	const profile = result.profile;
	if (!profile) {
		consola.warn(`Profile record at ${result.uri} doesn't match the lexicon.`);
	}
	const publisher = result.handle ?? result.did;
	const identifier = formatPackageIdentifier(publisher, result.slug);

	console.log();
	console.log(pc.bold(identifier));
	if (profile?.name && profile.name !== result.slug) console.log(`  Name: ${profile.name}`);
	if (profile?.description) console.log(`  ${profile.description}`);
	console.log();
	console.log(`  License:     ${profile?.license ?? "unknown"}`);
	if (result.latestVersion) console.log(`  Latest:      ${result.latestVersion}`);
	if (hosting) console.log(`  Hosting:     ${hosting}`);
	if (result.handle) console.log(`  Plugin page: ${pluginPageUrl(result.handle, result.slug)}`);
	console.log(`  Profile URI: ${pc.dim(result.uri)}`);
	console.log();

	if (result.labels && result.labels.length > 0) {
		consola.info(`Labels (${result.labels.length}):`);
		for (const label of result.labels) {
			console.log(`  ${pc.yellow(label.val)} ${pc.dim(`(by ${label.src})`)}`);
		}
	}
}

export async function getLatestReleaseForInfo<T>(
	latestVersion: string | null | undefined,
	lookup: () => Promise<T>,
): Promise<T | null> {
	if (!latestVersion) return null;
	try {
		return await lookup();
	} catch {
		return null;
	}
}

export async function hasVisibleReleaseForInfo(
	version: string,
	lookup: (
		cursor: string | undefined,
	) => Promise<{ releases: readonly { version: string }[]; cursor?: string }>,
): Promise<boolean> {
	let cursor: string | undefined;
	const seenCursors = new Set<string>();
	for (let pageIndex = 0; pageIndex < 100; pageIndex += 1) {
		const page = await lookup(cursor);
		if (page.releases.some((release) => release.version === version)) return true;
		if (!page.cursor || seenCursors.has(page.cursor)) return false;
		seenCursors.add(page.cursor);
		cursor = page.cursor;
	}
	return false;
}

function hostingMode(artifact: unknown): string | null {
	if (!artifact || typeof artifact !== "object") return null;
	const value = artifact as { blob?: unknown; url?: unknown };
	if (value.blob && typeof value.url === "string") return "publisher PDS blob + external URL";
	if (value.blob) return "publisher PDS blob";
	if (typeof value.url === "string") return "external URL";
	return "invalid (no blob or URL)";
}
