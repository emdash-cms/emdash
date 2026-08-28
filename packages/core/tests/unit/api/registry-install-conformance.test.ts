import {
	buildDidDocument,
	createFakePublisherFixture,
	type FakePublisher,
	type FakePublisherFixture,
} from "@emdash-cms/atproto-test-utils";
import { DirectPdsClient } from "@emdash-cms/registry-client/direct-pds";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	createDelegatedReleaseConformanceFixture,
	type DelegatedReleaseConformanceFixture,
	type DelegatedReleaseFixtureOptions,
} from "../../../../registry-verification/fixtures/conformance/delegated-release.js";
import { handleRegistryInstall, handleRegistryUpdate } from "../../../src/api/handlers/registry.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database } from "../../../src/database/types.js";
import type { SandboxRunner } from "../../../src/plugins/sandbox/types.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";
import { setDefaultRegistryArtifactTransport } from "../../../src/registry/artifact-fetch.js";
import type { AuthoritativeRecordReadOptions } from "../../../src/registry/authoritative-records.js";
import { setDefaultDnsResolver } from "../../../src/security/ssrf.js";
import type {
	DownloadResult,
	ListResult,
	SignedUploadUrl,
	Storage,
	UploadResult,
} from "../../../src/storage/types.js";

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

interface ConformanceContext {
	network: FakePublisherFixture;
	publisher: FakePublisher;
	options: AuthoritativeRecordReadOptions;
}

function createMemoryStorage(): Storage & { keys(): string[] } {
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
		keys: () => [...values.keys()].toSorted(),
	};
}

async function createContext(
	fixture: DelegatedReleaseConformanceFixture,
): Promise<ConformanceContext> {
	const network = createFakePublisherFixture();
	const publisher = await network.createPublisher({ did: fixture.publisherDid });
	await mountRecords(publisher, fixture);
	const options: AuthoritativeRecordReadOptions = {
		didDocumentResolver: {
			async resolve(did) {
				const document = network.didResolver.resolve(did);
				if (!document) throw new Error("DID not found");
				return document;
			},
		},
		fetch: pdsFetch(network),
		provenanceFetch: async () => new Response(fixture.provenanceDocument),
		resolveHostname: async () => ["93.184.216.34"],
		provenanceVerifier: fixture.provenanceVerifier,
	};
	return { network, publisher, options };
}

async function mountRecords(
	publisher: FakePublisher,
	fixture: DelegatedReleaseConformanceFixture,
): Promise<void> {
	await publisher.repo.putRecord(
		"com.emdashcms.experimental.package.profile",
		fixture.packageSlug,
		fixture.profile,
	);
	await publisher.repo.putRecord(
		"com.emdashcms.experimental.package.release",
		fixture.packageSlug + ":" + fixture.version,
		fixture.release,
	);
}

function pdsFetch(network: FakePublisherFixture): typeof fetch {
	return async (input, init) => {
		const url = input instanceof Request ? new URL(input.url) : new URL(String(input));
		return network.pds.handle(`${url.pathname}${url.search}`, init);
	};
}

async function mockAggregator(
	fixture: DelegatedReleaseConformanceFixture,
	context: ConformanceContext,
): Promise<void> {
	const direct = new DirectPdsClient({
		did: fixture.publisherDid,
		fetch: context.options.fetch,
		didDocumentResolver: context.options.didDocumentResolver,
	});
	const [profile, release] = await Promise.all([
		direct.getPackageProfile(fixture.packageSlug),
		direct.getPackageRelease(fixture.packageSlug, fixture.version),
	]);
	const releaseView = {
		uri: release.uri,
		cid: release.cid,
		did: fixture.publisherDid,
		package: fixture.packageSlug,
		version: fixture.version,
		indexedAt: "2026-01-01T00:00:00.000Z",
		labels: [],
		mirrors: [],
		release: {
			package: "aggregator-substitution",
			version: "99.0.0",
			artifacts: {
				package: {
					url: "https://attacker.example/bundle.tgz",
					checksum: "bciqaggregatorsubstitution",
				},
			},
		},
	};
	getPackage.mockResolvedValue({
		uri: profile.uri,
		cid: profile.cid,
		did: fixture.publisherDid,
		slug: fixture.packageSlug,
		labels: [],
		profile: { name: "Aggregator substitution" },
	});
	getLatestRelease.mockResolvedValue(releaseView);
	listReleases.mockResolvedValue({ releases: [releaseView] });
}

function artifactFetch(bytes: Uint8Array): ReturnType<typeof vi.fn> {
	const implementation = vi.fn(() => Promise.resolve(new Response(bytes)));
	vi.stubGlobal("fetch", implementation);
	return implementation;
}

const sandbox = { isAvailable: () => true } as unknown as SandboxRunner;
const registryConfig = { aggregatorUrl: "https://aggregator.test" };

describe("registry delegated-release conformance", () => {
	let db: Kysely<Database>;
	let storage: ReturnType<typeof createMemoryStorage>;
	let previousResolver: ReturnType<typeof setDefaultDnsResolver>;
	let previousTransport: ReturnType<typeof setDefaultRegistryArtifactTransport>;

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
	});

	afterEach(async () => {
		setDefaultDnsResolver(previousResolver);
		setDefaultRegistryArtifactTransport(previousTransport);
		vi.unstubAllGlobals();
		await db.destroy();
	});

	it("previews and installs one valid delegated release without trusting aggregator records", async () => {
		const fixture = await createDelegatedReleaseConformanceFixture();
		const context = await createContext(fixture);
		await mockAggregator(fixture, context);
		const fetch = artifactFetch(fixture.artifactBytes);

		const preview = await handleRegistryInstall(
			db,
			storage,
			sandbox,
			registryConfig,
			{ did: fixture.publisherDid, slug: fixture.packageSlug, version: fixture.version },
			{ verifyOnly: true, authoritativeRecords: context.options },
		);
		expect(preview).toMatchObject({
			success: true,
			data: {
				version: fixture.version,
				verification: {
					provenance: "verified",
					policy: { requireProvenance: true },
				},
			},
		});
		if (!preview.success) return;

		const installed = await handleRegistryInstall(
			db,
			storage,
			sandbox,
			registryConfig,
			{
				did: fixture.publisherDid,
				slug: fixture.packageSlug,
				version: fixture.version,
				acknowledgedDeclaredAccess: preview.data.capabilities,
				acknowledgedMcpTools: preview.data.mcpTools,
				acknowledgedProfileCid: preview.data.verification.profileCid,
				acknowledgedReleaseCid: preview.data.verification.releaseCid,
			},
			{ authoritativeRecords: context.options },
		);
		expect(installed).toMatchObject({
			success: true,
			data: {
				verification: {
					profileCid: preview.data.verification.profileCid,
					releaseCid: preview.data.verification.releaseCid,
					provenance: "verified",
				},
			},
		});
		if (!installed.success) return;
		expect(await new PluginStateRepository(db).get(installed.data.pluginId)).toMatchObject({
			version: fixture.version,
			registryPublisherDid: fixture.publisherDid,
			registrySlug: fixture.packageSlug,
		});
		expect(storage.keys()).toEqual([
			`registry/${installed.data.pluginId}/${fixture.version}/admin.js`,
			`registry/${installed.data.pluginId}/${fixture.version}/backend.js`,
			`registry/${installed.data.pluginId}/${fixture.version}/manifest.json`,
		]);
		expect(fetch).toHaveBeenCalledWith(
			fixture.artifactUrl,
			expect.objectContaining({ redirect: "manual" }),
		);
	});

	it.each(["sha384", "sha512"] as const)(
		"previews provenance whose subject uses %s",
		async (provenanceDigestAlgorithm) => {
			const fixture = await createDelegatedReleaseConformanceFixture({
				provenanceDigestAlgorithm,
			});
			const context = await createContext(fixture);
			await mockAggregator(fixture, context);
			artifactFetch(fixture.artifactBytes);

			await expect(
				handleRegistryInstall(
					db,
					storage,
					sandbox,
					registryConfig,
					{ did: fixture.publisherDid, slug: fixture.packageSlug, version: fixture.version },
					{ verifyOnly: true, authoritativeRecords: context.options },
				),
			).resolves.toMatchObject({
				success: true,
				data: { verification: { provenance: "verified" } },
			});
		},
	);

	it("updates with the same verification and CID-bound re-consent", async () => {
		const initial = await createDelegatedReleaseConformanceFixture();
		const context = await createContext(initial);
		await mockAggregator(initial, context);
		artifactFetch(initial.artifactBytes);
		const preview = await handleRegistryInstall(
			db,
			storage,
			sandbox,
			registryConfig,
			{ did: initial.publisherDid, slug: initial.packageSlug, version: initial.version },
			{ verifyOnly: true, authoritativeRecords: context.options },
		);
		if (!preview.success) throw new Error(preview.error.message);
		const installed = await handleRegistryInstall(
			db,
			storage,
			sandbox,
			registryConfig,
			{
				did: initial.publisherDid,
				slug: initial.packageSlug,
				version: initial.version,
				acknowledgedDeclaredAccess: preview.data.capabilities,
				acknowledgedMcpTools: preview.data.mcpTools,
				acknowledgedProfileCid: preview.data.verification.profileCid,
				acknowledgedReleaseCid: preview.data.verification.releaseCid,
			},
			{ authoritativeRecords: context.options },
		);
		if (!installed.success) throw new Error(installed.error.message);

		const next = await createDelegatedReleaseConformanceFixture({
			version: "1.2.4",
			declaredAccess: { content: { read: {} }, users: { read: {} } },
		});
		await context.publisher.repo.putRecord(
			"com.emdashcms.experimental.package.release",
			next.packageSlug + ":" + next.version,
			next.release,
		);
		const nextOptions: AuthoritativeRecordReadOptions = {
			...context.options,
			provenanceFetch: async () => new Response(next.provenanceDocument),
			provenanceVerifier: next.provenanceVerifier,
		};
		await mockAggregator(next, context);
		artifactFetch(next.artifactBytes);

		const preflight = await handleRegistryUpdate(
			db,
			storage,
			sandbox,
			registryConfig,
			installed.data.pluginId,
			{ authoritativeRecords: nextOptions },
		);
		expect(preflight).toMatchObject({
			success: false,
			error: {
				code: "CAPABILITY_ESCALATION",
				details: {
					capabilityChanges: { added: ["users:read"] },
					verification: { provenance: "verified" },
				},
			},
		});
		if (preflight.success) return;
		const verification = Reflect.get(preflight.error.details ?? {}, "verification");
		if (!verification || typeof verification !== "object") {
			throw new Error("missing update verification");
		}
		const profileCid = Reflect.get(verification, "profileCid");
		const releaseCid = Reflect.get(verification, "releaseCid");
		if (typeof profileCid !== "string" || typeof releaseCid !== "string") {
			throw new Error("invalid update verification");
		}

		const updated = await handleRegistryUpdate(
			db,
			storage,
			sandbox,
			registryConfig,
			installed.data.pluginId,
			{
				authoritativeRecords: nextOptions,
				confirmCapabilityChanges: true,
				acknowledgedProfileCid: profileCid,
				acknowledgedReleaseCid: releaseCid,
			},
		);
		expect(updated).toMatchObject({
			success: true,
			data: {
				oldVersion: initial.version,
				newVersion: next.version,
				verification: { profileCid, releaseCid, provenance: "verified" },
			},
		});
		expect(await new PluginStateRepository(db).get(installed.data.pluginId)).toMatchObject({
			version: next.version,
		});
	});

	it.each([
		["manifest identity", { manifestId: "other" }, "MANIFEST_ID_MISMATCH", undefined],
		["manifest version", { manifestVersion: "9.9.9" }, "MANIFEST_VERSION_MISMATCH", undefined],
		[
			"declared access",
			{
				declaredAccess: { users: { read: {} } },
				manifestDeclaredAccess: { content: { read: {} } },
			},
			"DECLARED_ACCESS_DRIFT",
			undefined,
		],
		[
			"release package",
			{ releasePackage: "other" },
			"RECORD_VERIFICATION_FAILED",
			"RELEASE_PACKAGE_MISMATCH",
		],
		[
			"release version",
			{ releaseVersion: "9.9.9" },
			"RECORD_VERIFICATION_FAILED",
			"RELEASE_VERSION_MISMATCH",
		],
		[
			"provenance source",
			{ provenance: { sourceRepository: "https://github.com/attacker/gallery" } },
			"RECORD_VERIFICATION_FAILED",
			"PROVENANCE_UNVERIFIABLE",
		],
		[
			"provenance builder",
			{ provenance: { builderId: "https://github.com/attacker/workflow@refs/heads/main" } },
			"RECORD_VERIFICATION_FAILED",
			"PROVENANCE_UNVERIFIABLE",
		],
	] satisfies Array<[string, DelegatedReleaseFixtureOptions, string, string | undefined]>)(
		"rejects %s substitution",
		async (_name, fixtureOptions, code, verificationCode) => {
			const fixture = await createDelegatedReleaseConformanceFixture(fixtureOptions);
			const context = await createContext(fixture);
			await mockAggregator(fixture, context);
			artifactFetch(fixture.artifactBytes);

			const result = await handleRegistryInstall(
				db,
				storage,
				sandbox,
				registryConfig,
				{ did: fixture.publisherDid, slug: fixture.packageSlug, version: fixture.version },
				{ verifyOnly: true, authoritativeRecords: context.options },
			);

			expect(result).toMatchObject({
				success: false,
				error: {
					code,
					...(verificationCode ? { details: { verificationCode } } : {}),
				},
			});
		},
	);

	it("rejects artifact bytes substituted behind the signed URL", async () => {
		const fixture = await createDelegatedReleaseConformanceFixture();
		const context = await createContext(fixture);
		await mockAggregator(fixture, context);
		artifactFetch(new TextEncoder().encode("substituted"));

		await expect(
			handleRegistryInstall(
				db,
				storage,
				sandbox,
				registryConfig,
				{ did: fixture.publisherDid, slug: fixture.packageSlug, version: fixture.version },
				{ verifyOnly: true, authoritativeRecords: context.options },
			),
		).resolves.toMatchObject({
			success: false,
			error: { code: "CHECKSUM_MISMATCH" },
		});
	});

	it("rejects a repository proof signed by a substituted key", async () => {
		const fixture = await createDelegatedReleaseConformanceFixture();
		const context = await createContext(fixture);
		const attacker = await context.network.createPublisher({
			did: "did:plc:attacker000000000000000",
		});
		const wrongDocument = buildDidDocument({
			did: fixture.publisherDid,
			signingKeyMultibase: attacker.repo.didKey().replace(/^did:key:/, ""),
			pdsEndpoint: context.network.pdsBaseUrl,
		});
		await mockAggregator(fixture, context);
		artifactFetch(fixture.artifactBytes);

		await expect(
			handleRegistryInstall(
				db,
				storage,
				sandbox,
				registryConfig,
				{ did: fixture.publisherDid, slug: fixture.packageSlug, version: fixture.version },
				{
					verifyOnly: true,
					authoritativeRecords: {
						...context.options,
						didDocumentResolver: { resolve: () => Promise.resolve(wrongDocument) },
					},
				},
			),
		).resolves.toMatchObject({
			success: false,
			error: {
				code: "RECORD_VERIFICATION_FAILED",
				details: { verificationCode: "RECORD_PROOF_INVALID" },
			},
		});
	});
});
