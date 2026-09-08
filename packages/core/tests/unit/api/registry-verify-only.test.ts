import { gzipSync } from "node:zlib";

import { inspectPackageReleaseRecords } from "@emdash-cms/registry-verification";
import { computeMultihash } from "@emdash-cms/registry-verification/checksum";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { packTar, type TarEntry } from "modern-tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleRegistryInstall } from "../../../src/api/handlers/registry.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database } from "../../../src/database/types.js";
import type { SandboxRunner } from "../../../src/plugins/sandbox/types.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";
import { setDefaultRegistryArtifactTransport } from "../../../src/registry/artifact-fetch.js";
import type { AuthoritativeRecordReader } from "../../../src/registry/authoritative-records.js";
import { setDefaultDnsResolver } from "../../../src/security/ssrf.js";
import type { Storage } from "../../../src/storage/types.js";

const PUBLISHER_DID = "did:plc:verify00000000000000000";
const SLUG = "gallery";
const VERSION = "1.0.0";
const ARTIFACT_URL = "https://artifacts.example.test/gallery.tar.gz";
const PROFILE_NSID = "com.emdashcms.experimental.package.profile";
const RELEASE_NSID = "com.emdashcms.experimental.package.release";
const encoder = new TextEncoder();

const getPackage = vi.fn();
const getLatestRelease = vi.fn();
const listReleases = vi.fn();

vi.mock("@emdash-cms/registry-client/discovery", () => ({
	DiscoveryClient: class {
		labelerPolicy = { enforcement: "required" as const };
		getPackage = getPackage;
		getLatestRelease = getLatestRelease;
		listReleases = listReleases;
	},
	registryLabelerPolicy: (acceptLabelers?: string) => ({
		enforcement: "required",
		acceptLabelers,
	}),
}));

function file(name: string, body: string): TarEntry {
	const bytes = encoder.encode(body);
	return { header: { name, size: bytes.byteLength, type: "file" }, body: bytes };
}

async function pluginBundle(): Promise<Uint8Array> {
	const manifest = {
		id: SLUG,
		version: VERSION,
		declaredAccess: { users: { read: {} } },
		capabilities: ["users:read"],
		allowedHosts: [],
		storage: {},
		hooks: [],
		routes: [],
		admin: {},
	};
	return new Uint8Array(
		gzipSync(
			await packTar([
				file("manifest.json", JSON.stringify(manifest)),
				file("backend.js", "export default {};"),
			]),
		),
	);
}

async function authoritativeReader(checksum: string): Promise<AuthoritativeRecordReader> {
	const profile = {
		$type: PROFILE_NSID,
		id: `at://${PUBLISHER_DID}/${PROFILE_NSID}/${SLUG}`,
		slug: SLUG,
		type: "emdash-plugin",
		name: "Verified Gallery",
		license: "MIT",
		authors: [{ name: "Publisher" }],
		security: [{ email: "security@example.test" }],
		extensions: {
			"com.emdashcms.experimental.package.profileExtension": {
				$type: "com.emdashcms.experimental.package.profileExtension",
				repository: "https://github.com/example/gallery",
			},
		},
	};
	const release = {
		$type: RELEASE_NSID,
		package: SLUG,
		version: VERSION,
		artifacts: { package: { url: ARTIFACT_URL, checksum } },
		extensions: {
			"com.emdashcms.experimental.package.releaseExtension": {
				$type: "com.emdashcms.experimental.package.releaseExtension",
				declaredAccess: { users: { read: {} } },
			},
		},
	};
	const inspection = await inspectPackageReleaseRecords({
		publisherDid: PUBLISHER_DID,
		package: SLUG,
		version: VERSION,
		rkey: `${SLUG}:${VERSION}`,
		profile,
		release,
	});
	if (!inspection.success) throw new Error(inspection.reasons[0]?.message);
	return async () => ({
		success: true,
		value: {
			publisherDid: PUBLISHER_DID,
			packageSlug: SLUG,
			version: VERSION,
			profile: {
				uri: profile.id,
				cid: "bafy-profile",
				rkey: SLUG,
				value: profile,
			},
			release: {
				uri: `at://${PUBLISHER_DID}/${RELEASE_NSID}/${SLUG}:${VERSION}`,
				cid: "bafy-release",
				rkey: `${SLUG}:${VERSION}`,
				value: release,
			},
			inspection,
		},
	});
}

describe("handleRegistryInstall verifyOnly", () => {
	let db: Kysely<Database>;
	let previousResolver: ReturnType<typeof setDefaultDnsResolver>;
	let previousTransport: ReturnType<typeof setDefaultRegistryArtifactTransport>;

	beforeEach(async () => {
		db = new Kysely<Database>({
			dialect: new SqliteDialect({ database: new BetterSqlite3(":memory:") }),
		});
		await runMigrations(db);
		previousResolver = setDefaultDnsResolver(async () => ["93.184.216.34"]);
		previousTransport = setDefaultRegistryArtifactTransport({
			async fetch({ url, allowedAddresses, signal }) {
				const response = await globalThis.fetch(url.href, { redirect: "manual", signal });
				return { response, connectedAddress: allowedAddresses[0] ?? "93.184.216.34" };
			},
		});
		getPackage.mockReset();
		getLatestRelease.mockReset();
		listReleases.mockReset();
	});

	afterEach(async () => {
		setDefaultDnsResolver(previousResolver);
		setDefaultRegistryArtifactTransport(previousTransport);
		vi.unstubAllGlobals();
		await db.destroy();
	});

	it("returns authoritative consent evidence without writing storage or plugin state", async () => {
		const bytes = await pluginBundle();
		const checksum = await computeMultihash(bytes);
		if (!checksum.success) throw new Error(checksum.error.message);
		getPackage.mockResolvedValue({
			uri: `at://${PUBLISHER_DID}/${PROFILE_NSID}/${SLUG}`,
			cid: "bafy-profile",
			did: PUBLISHER_DID,
			slug: SLUG,
			labels: [],
			profile: { name: "Untrusted aggregator copy" },
		});
		const releaseView = {
			uri: `at://${PUBLISHER_DID}/${RELEASE_NSID}/${SLUG}:${VERSION}`,
			cid: "bafy-release",
			did: PUBLISHER_DID,
			package: SLUG,
			version: VERSION,
			indexedAt: "2026-01-01T00:00:00.000Z",
			labels: [],
			mirrors: [],
			release: {
				package: SLUG,
				version: VERSION,
				artifacts: { package: { url: "https://evil.example/bundle", checksum: "wrong" } },
			},
		};
		getLatestRelease.mockResolvedValue(releaseView);
		listReleases.mockResolvedValue({ releases: [releaseView] });
		const fetch = vi.fn(() => Promise.resolve(new Response(bytes, { status: 200 })));
		vi.stubGlobal("fetch", fetch);
		const upload = vi.fn();
		const storage = { upload } as unknown as Storage;
		const sandbox = { isAvailable: () => true } as unknown as SandboxRunner;

		const result = await handleRegistryInstall(
			db,
			storage,
			sandbox,
			{ aggregatorUrl: "https://aggregator.test" },
			{ did: PUBLISHER_DID, slug: SLUG, version: VERSION },
			{
				verifyOnly: true,
				readAuthoritativeRecords: await authoritativeReader(checksum.value),
			},
		);

		expect(result).toMatchObject({
			success: true,
			data: {
				capabilities: ["users:read"],
				declaredAccess: { users: { read: {} } },
				verification: {
					profileCid: "bafy-profile",
					releaseCid: "bafy-release",
					provenance: "absent-optional",
				},
			},
		});
		expect(fetch).toHaveBeenCalledWith(
			ARTIFACT_URL,
			expect.objectContaining({ redirect: "manual" }),
		);
		expect(upload).not.toHaveBeenCalled();
		if (!result.success) return;
		expect(await new PluginStateRepository(db).get(result.data.pluginId)).toBeNull();
	});

	it("rejects an aggregator CID that differs from the publisher's signed release", async () => {
		const bytes = await pluginBundle();
		const checksum = await computeMultihash(bytes);
		if (!checksum.success) throw new Error(checksum.error.message);
		getPackage.mockResolvedValue({
			uri: `at://${PUBLISHER_DID}/${PROFILE_NSID}/${SLUG}`,
			cid: "bafy-profile",
			did: PUBLISHER_DID,
			slug: SLUG,
			labels: [],
			profile: null,
		});
		const releaseView = {
			uri: `at://${PUBLISHER_DID}/${RELEASE_NSID}/${SLUG}:${VERSION}`,
			cid: "bafy-stale-release",
			did: PUBLISHER_DID,
			package: SLUG,
			version: VERSION,
			indexedAt: "2026-01-01T00:00:00.000Z",
			labels: [],
			mirrors: [],
			release: null,
		};
		getLatestRelease.mockResolvedValue(releaseView);
		listReleases.mockResolvedValue({ releases: [releaseView] });
		const fetch = vi.fn(() => {
			throw new Error("artifact fetch must not run for mismatched record metadata");
		});
		vi.stubGlobal("fetch", fetch);

		const result = await handleRegistryInstall(
			db,
			{} as Storage,
			{ isAvailable: () => true } as unknown as SandboxRunner,
			{ aggregatorUrl: "https://aggregator.test" },
			{ did: PUBLISHER_DID, slug: SLUG, version: VERSION },
			{
				verifyOnly: true,
				readAuthoritativeRecords: await authoritativeReader(checksum.value),
			},
		);

		expect(result).toMatchObject({
			success: false,
			error: { code: "AGGREGATOR_RECORD_MISMATCH" },
		});
		expect(fetch).not.toHaveBeenCalled();
	});

	it.each([
		["missing", {}, "RECORD_CONSENT_REQUIRED"],
		[
			"stale",
			{ acknowledgedProfileCid: "bafy-old-profile", acknowledgedReleaseCid: "bafy-old-release" },
			"RECORD_VERIFICATION_DRIFT",
		],
	] as const)(
		"rejects %s record consent before fetching artifact bytes",
		async (_case, cids, code) => {
			const releaseView = {
				uri: `at://${PUBLISHER_DID}/${RELEASE_NSID}/${SLUG}:${VERSION}`,
				cid: "bafy-release",
				did: PUBLISHER_DID,
				package: SLUG,
				version: VERSION,
				indexedAt: "2026-01-01T00:00:00.000Z",
				labels: [],
				mirrors: [],
				release: null,
			};
			getPackage.mockResolvedValue({
				uri: `at://${PUBLISHER_DID}/${PROFILE_NSID}/${SLUG}`,
				cid: "bafy-profile",
				did: PUBLISHER_DID,
				slug: SLUG,
				labels: [],
				profile: null,
			});
			listReleases.mockResolvedValue({ releases: [releaseView] });
			const fetch = vi.fn(() => {
				throw new Error("artifact fetch must not run before record consent");
			});
			vi.stubGlobal("fetch", fetch);

			const result = await handleRegistryInstall(
				db,
				{} as Storage,
				{ isAvailable: () => true } as unknown as SandboxRunner,
				{ aggregatorUrl: "https://aggregator.test" },
				{ did: PUBLISHER_DID, slug: SLUG, version: VERSION, ...cids },
				{ readAuthoritativeRecords: await authoritativeReader("bciqexample") },
			);

			expect(result).toMatchObject({ success: false, error: { code } });
			expect(fetch).not.toHaveBeenCalled();
		},
	);
});
