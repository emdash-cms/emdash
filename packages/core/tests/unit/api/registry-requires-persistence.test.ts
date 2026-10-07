/**
 * Persistence of the signed release record's `requires` into the stored
 * bundle manifest.
 *
 * The load-time env gate reads `requires` from the stored bundle's raw
 * `manifest.json`, but plugin-cli authors `requires` as a release-record
 * field only. These tests drive the real install/update handlers and assert
 * the guarded record value lands in the stored manifest — injected from the
 * signed record (never from publisher-authored bundle bytes, since the
 * stored manifest is unsigned), refreshed on update, and honored by the
 * load-time gate end to end.
 */

import { randomUUID } from "node:crypto";
import { gzipSync } from "node:zlib";

import { inspectPackageReleaseRecords } from "@emdash-cms/registry-verification";
import { computeMultihash } from "@emdash-cms/registry-verification/checksum";
import { Kysely, SqliteDialect } from "kysely";
import { packTar, type TarEntry } from "modern-tar";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { NodeSqliteCompatDatabase as BetterSqlite3 } from "#node-sqlite";

import { handleRegistryInstall, handleRegistryUpdate } from "../../../src/api/handlers/registry.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database } from "../../../src/database/types.js";
import { openNodeSqliteDatabase } from "../../../src/db/node-sqlite-compat.js";
import { EmDashRuntime, type RuntimeDependencies } from "../../../src/emdash-runtime.js";
import type { SandboxedPluginInstance, SandboxRunner } from "../../../src/plugins/sandbox/types.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";
import { setDefaultRegistryArtifactTransport } from "../../../src/registry/artifact-fetch.js";
import type { AuthoritativeRecordReader } from "../../../src/registry/authoritative-records.js";
import { setDefaultDnsResolver } from "../../../src/security/ssrf.js";
import type {
	DownloadResult,
	ListResult,
	SignedUploadUrl,
	Storage,
	UploadResult,
} from "../../../src/storage/types.js";

const PUBLISHER_DID = "did:plc:requires000000000000000";
const SLUG = "gallery";
const PROFILE_NSID = "com.emdashcms.experimental.package.profile";
const RELEASE_NSID = "com.emdashcms.experimental.package.release";
const PROFILE_CID = "bafy-profile";
const RELEASE_CID = `bafyrei${"a".repeat(52)}`;
const ARTIFACT_URL = "https://artifacts.example.test/gallery.tar.gz";
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

function createMemoryStorage(): Storage {
	const values = new Map<string, { body: Uint8Array; contentType: string }>();
	return {
		async upload(input): Promise<UploadResult> {
			let body: Uint8Array;
			if (input.body instanceof Uint8Array) {
				body = input.body;
			} else if (input.body instanceof ReadableStream) {
				body = new Uint8Array(await new Response(input.body).arrayBuffer());
			} else {
				body = new Uint8Array(input.body);
			}
			values.set(input.key, { body, contentType: input.contentType });
			return { key: input.key, url: "https://storage.example/" + input.key, size: body.length };
		},
		async download(key): Promise<DownloadResult> {
			const value = values.get(key);
			if (!value) throw new Error("Not found: " + key);
			return {
				body: new Blob([new Uint8Array(value.body)]).stream(),
				contentType: value.contentType,
				size: value.body.length,
			};
		},
		async delete(key): Promise<void> {
			values.delete(key);
		},
		async exists(key): Promise<boolean> {
			return values.has(key);
		},
		async list(prefix): Promise<ListResult> {
			return {
				items: [...values.entries()]
					.filter(([key]) => key.startsWith(prefix))
					.map(([key, value]) => ({ key, size: value.body.length })),
			};
		},
		async getSignedUploadUrl(): Promise<SignedUploadUrl> {
			throw new Error("Not implemented");
		},
	};
}

function file(name: string, body: string): TarEntry {
	const bytes = encoder.encode(body);
	return { header: { name, size: bytes.byteLength, type: "file" }, body: bytes };
}

async function pluginBundle(options: {
	version: string;
	bundleRequires?: Record<string, string>;
}): Promise<Uint8Array> {
	const manifest: Record<string, unknown> = {
		id: SLUG,
		version: options.version,
		declaredAccess: { users: { read: {} } },
		capabilities: ["users:read"],
		allowedHosts: [],
		storage: {},
		hooks: [],
		routes: [],
		admin: {},
	};
	if (options.bundleRequires) manifest.requires = options.bundleRequires;
	return new Uint8Array(
		gzipSync(
			await packTar([
				file("manifest.json", JSON.stringify(manifest)),
				file("backend.js", "export default {};"),
			]),
		),
	);
}

function packageView() {
	return {
		uri: `at://${PUBLISHER_DID}/${PROFILE_NSID}/${SLUG}`,
		cid: PROFILE_CID,
		did: PUBLISHER_DID,
		slug: SLUG,
		labels: [],
		profile: {},
	};
}

function releaseView(version: string, requires: Record<string, string> | undefined) {
	return {
		uri: `at://${PUBLISHER_DID}/${RELEASE_NSID}/${SLUG}:${version}`,
		cid: RELEASE_CID,
		did: PUBLISHER_DID,
		package: SLUG,
		version,
		indexedAt: "2026-01-01T00:00:00.000Z",
		labels: [],
		mirrors: [],
		release: {
			package: SLUG,
			version,
			...(requires ? { requires } : {}),
			artifacts: { package: { url: ARTIFACT_URL, checksum: "sha256-deadbeef" } },
		},
	};
}

async function authoritativeReader(
	version: string,
	requires: Record<string, string> | undefined,
	checksum: string,
): Promise<AuthoritativeRecordReader> {
	const profile = {
		$type: PROFILE_NSID,
		id: `at://${PUBLISHER_DID}/${PROFILE_NSID}/${SLUG}`,
		slug: SLUG,
		type: "emdash-plugin",
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
		version,
		...(requires ? { requires } : {}),
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
		version,
		rkey: `${SLUG}:${version}`,
		profile,
		release,
	});
	if (!inspection.success) throw new Error(inspection.reasons[0]?.message);
	return async () => ({
		success: true,
		value: {
			publisherDid: PUBLISHER_DID,
			packageSlug: SLUG,
			version,
			profile: { uri: profile.id, cid: PROFILE_CID, rkey: SLUG, value: profile },
			release: {
				uri: `at://${PUBLISHER_DID}/${RELEASE_NSID}/${SLUG}:${version}`,
				cid: RELEASE_CID,
				rkey: `${SLUG}:${version}`,
				value: release,
			},
			inspection,
		},
	});
}

describe("registry requires persistence", () => {
	let db: Kysely<Database>;
	let storage: Storage;
	let previousResolver: ReturnType<typeof setDefaultDnsResolver>;
	let previousTransport: ReturnType<typeof setDefaultRegistryArtifactTransport>;
	const sandbox = { isAvailable: () => true } as unknown as SandboxRunner;
	const registryConfig = { aggregatorUrl: "https://aggregator.test" };

	beforeEach(async () => {
		db = new Kysely<Database>({
			dialect: new SqliteDialect({ database: new BetterSqlite3(":memory:") }),
		});
		await runMigrations(db);
		storage = createMemoryStorage();
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
		getPackage.mockResolvedValue(packageView());
	});

	afterEach(async () => {
		setDefaultDnsResolver(previousResolver);
		setDefaultRegistryArtifactTransport(previousTransport);
		vi.unstubAllGlobals();
		await db.destroy();
	});

	async function storedManifestJson(pluginId: string, version: string): Promise<unknown> {
		const result = await storage.download(`registry/${pluginId}/${version}/manifest.json`);
		return JSON.parse(await new Response(result.body).text());
	}

	async function installRelease(options: {
		version: string;
		recordRequires?: Record<string, string>;
		hostEnv: { "env:astro": string };
		bundleRequires?: Record<string, string>;
	}): Promise<string> {
		const bytes = await pluginBundle({
			version: options.version,
			bundleRequires: options.bundleRequires,
		});
		const checksum = await computeMultihash(bytes);
		if (!checksum.success) throw new Error(checksum.error.message);
		const view = releaseView(options.version, options.recordRequires);
		getLatestRelease.mockResolvedValue(view);
		listReleases.mockResolvedValue({ releases: [view] });
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response(bytes))),
		);
		const reader = await authoritativeReader(
			options.version,
			options.recordRequires,
			checksum.value,
		);

		const preview = await handleRegistryInstall(
			db,
			storage,
			sandbox,
			registryConfig,
			{ did: PUBLISHER_DID, slug: SLUG, version: options.version },
			{ verifyOnly: true, readAuthoritativeRecords: reader },
		);
		expect(preview.success, JSON.stringify(preview.error)).toBe(true);
		if (!preview.success) throw new Error(`verify-only install failed: ${preview.error.code}`);

		const installed = await handleRegistryInstall(
			db,
			storage,
			sandbox,
			registryConfig,
			{
				did: PUBLISHER_DID,
				slug: SLUG,
				version: options.version,
				acknowledgedDeclaredAccess: preview.data.capabilities,
				acknowledgedProfileCid: preview.data.verification.profileCid,
				acknowledgedReleaseCid: preview.data.verification.releaseCid,
			},
			{ hostEnv: options.hostEnv, readAuthoritativeRecords: reader },
		);
		expect(installed.success).toBe(true);
		if (!installed.success) throw new Error(`install failed: ${installed.error.message}`);
		return installed.data.pluginId;
	}

	it("stores the signed record's requires in the stored bundle manifest", async () => {
		const pluginId = await installRelease({
			version: "1.0.0",
			recordRequires: { "env:astro": "^5.0.0" },
			hostEnv: { "env:astro": "5.6.0" },
		});

		const stored = await storedManifestJson(pluginId, "1.0.0");
		expect(stored).toMatchObject({ requires: { "env:astro": "^5.0.0" } });
	});

	it("injects the record's guarded requires, not publisher-authored bundle bytes", async () => {
		const pluginId = await installRelease({
			version: "1.0.0",
			recordRequires: { "env:astro": "^5.0.0" },
			hostEnv: { "env:astro": "5.6.0" },
			// Bundle bytes try to smuggle a self-blocking range and a
			// non-guarded key. The stored manifest must carry only the signed
			// record's guarded value — the stored manifest is unsigned, so
			// bundle-authored bytes are never authoritative for `requires`.
			bundleRequires: { "env:astro": "^999.0.0", "not-an-env-key": "^1.0.0" },
		});

		const stored = await storedManifestJson(pluginId, "1.0.0");
		expect(stored).toMatchObject({ requires: { "env:astro": "^5.0.0" } });
	});

	it("stores no requires key when neither the record nor a previous install carries any", async () => {
		const pluginId = await installRelease({
			version: "1.0.0",
			hostEnv: { "env:astro": "5.6.0" },
			bundleRequires: { "env:astro": "^999.0.0" },
		});

		const stored = (await storedManifestJson(pluginId, "1.0.0")) as Record<string, unknown>;
		expect(Object.hasOwn(stored, "requires")).toBe(false);
	});

	it("refreshes the stored requires on update, including removal", async () => {
		const pluginId = await installRelease({
			version: "1.0.0",
			recordRequires: { "env:astro": "^5.0.0" },
			hostEnv: { "env:astro": "5.6.0" },
		});

		// Update to 2.0.0 whose record carries a different constraint.
		const v2Bytes = await pluginBundle({ version: "2.0.0" });
		const v2Checksum = await computeMultihash(v2Bytes);
		if (!v2Checksum.success) throw new Error(v2Checksum.error.message);
		const v2View = releaseView("2.0.0", { "env:astro": "^6.0.0" });
		getLatestRelease.mockResolvedValue(v2View);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response(v2Bytes))),
		);

		const updated = await handleRegistryUpdate(db, storage, sandbox, registryConfig, pluginId, {
			hostEnv: { "env:astro": "6.1.0" },
			readAuthoritativeRecords: await authoritativeReader(
				"2.0.0",
				{ "env:astro": "^6.0.0" },
				v2Checksum.value,
			),
		});
		expect(updated.success).toBe(true);
		if (!updated.success) throw new Error(`update failed: ${updated.error.message}`);

		const storedV2 = await storedManifestJson(pluginId, "2.0.0");
		expect(storedV2).toMatchObject({ requires: { "env:astro": "^6.0.0" } });
		// The previous bundle's manifest is untouched.
		const storedV1 = await storedManifestJson(pluginId, "1.0.0");
		expect(storedV1).toMatchObject({ requires: { "env:astro": "^5.0.0" } });

		// Update to 3.0.0 whose record drops `requires` — the stored
		// manifest must drop it too (a stale range must not survive).
		const v3Bytes = await pluginBundle({ version: "3.0.0" });
		const v3Checksum = await computeMultihash(v3Bytes);
		if (!v3Checksum.success) throw new Error(v3Checksum.error.message);
		const v3View = releaseView("3.0.0", undefined);
		getLatestRelease.mockResolvedValue(v3View);
		vi.stubGlobal(
			"fetch",
			vi.fn(() => Promise.resolve(new Response(v3Bytes))),
		);

		const updatedAgain = await handleRegistryUpdate(
			db,
			storage,
			sandbox,
			registryConfig,
			pluginId,
			{
				hostEnv: { "env:astro": "6.1.0" },
				readAuthoritativeRecords: await authoritativeReader("3.0.0", undefined, v3Checksum.value),
			},
		);
		expect(updatedAgain.success).toBe(true);

		const storedV3 = (await storedManifestJson(pluginId, "3.0.0")) as Record<string, unknown>;
		expect(Object.hasOwn(storedV3, "requires")).toBe(false);
	});

	it("skips the installed plugin at load when the host no longer satisfies the stored range", async () => {
		const pluginId = await installRelease({
			version: "1.0.0",
			recordRequires: { "env:astro": "^5.6.0" },
			hostEnv: { "env:astro": "5.6.0" },
		});

		// The same site "restarted" on a host whose astro version no longer
		// satisfies the persisted range (the config seam stands in for an
		// upgrade — VERSION is "dev" under vitest, so env:emdash is skipped
		// by design and the gate is exercised through env:astro).
		const sqlite = openNodeSqliteDatabase(":memory:");
		const dialect = new SqliteDialect({ database: sqlite });
		const runtimeDb = new Kysely<Database>({ dialect });
		await runMigrations(runtimeDb);
		await new PluginStateRepository(runtimeDb).upsert(pluginId, "1.0.0", "active", {
			source: "registry",
			registryPublisherDid: PUBLISHER_DID,
			registrySlug: SLUG,
		});
		// Re-store the bundle the install handler produced into the runtime's
		// storage (the install above used a per-test storage instance).
		const runtimeStorage = createMemoryStorage();
		const v1Manifest = await storedManifestJson(pluginId, "1.0.0");
		await runtimeStorage.upload({
			key: `registry/${pluginId}/1.0.0/manifest.json`,
			body: encoder.encode(JSON.stringify(v1Manifest)),
			contentType: "application/json",
		});
		const v1Backend = await storage.download(`registry/${pluginId}/1.0.0/backend.js`);
		await runtimeStorage.upload({
			key: `registry/${pluginId}/1.0.0/backend.js`,
			body: new Uint8Array(await new Response(v1Backend.body).arrayBuffer()),
			contentType: "application/javascript",
		});

		const loadCalls: Array<{ id: string; version: string }> = [];
		const runner = {
			isAvailable: () => true,
			isHealthy: () => true,
			load: vi.fn(async (manifest: { id: string; version: string; capabilities: string[] }) => {
				loadCalls.push({ id: manifest.id, version: manifest.version });
				return {
					id: `${manifest.id}:${manifest.version}`,
					invokeHook: vi.fn(),
					invokeRoute: vi.fn(),
					terminate: vi.fn(),
				} as unknown as SandboxedPluginInstance;
			}),
			setEmailSend: vi.fn(),
			terminateAll: vi.fn(),
		};

		const runtimeDeps: RuntimeDependencies = {
			config: {
				database: {
					entrypoint: `test-requires-persist-${randomUUID()}`,
					config: {},
					type: "sqlite",
				},
				storage: { entrypoint: `memory-${randomUUID()}`, config: {} },
				registry: "https://registry.example.com",
				astroVersion: "6.0.0",
			},
			plugins: [],
			createDialect: () => dialect,
			createStorage: () => runtimeStorage,
			createScheduler: null,
			sandboxEnabled: true,
			sandboxedPluginEntries: [],
			// eslint-disable-next-line typescript/no-explicit-any -- fake implements the published runner boundary
			createSandboxRunner: (() => runner) as any,
		};

		const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
		try {
			const runtime = await EmDashRuntime.create(runtimeDeps);

			// The gate fired from the persisted record value: never loaded,
			// mismatch recorded for the admin list, DB row still active.
			expect(loadCalls).toEqual([]);
			expect(runtime.getSandboxedPluginLoadIncompatibility(pluginId)).toEqual([
				{ key: "env:astro", required: "^5.6.0", host: "6.0.0" },
			]);
			const state = await new PluginStateRepository(runtime.db).get(pluginId);
			expect(state?.status).toBe("active");

			await runtime.stopCron();
		} finally {
			warn.mockRestore();
			await runtimeDb.destroy();
		}
	});
});
