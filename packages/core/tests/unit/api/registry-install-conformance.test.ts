import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
	buildDidDocument,
	createFakePublisherFixture,
	type FakePublisher,
	type FakePublisherFixture,
} from "@emdash-cms/atproto-test-utils";
import { canonicalizeDeclaredAccess } from "@emdash-cms/plugin-types";
import { DirectPdsClient } from "@emdash-cms/registry-client/direct-pds";
import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildPlugin } from "../../../../plugin-cli/src/build/api.js";
import {
	createDelegatedReleaseConformanceFixture,
	type DelegatedReleaseConformanceFixture,
	type DelegatedReleaseFixtureOptions,
} from "../../../../registry-verification/fixtures/conformance/delegated-release.js";
import { WorkerdSandboxRunner } from "../../../../workerd/src/sandbox/runner.js";
import { loadBundleFromR2 } from "../../../src/api/handlers/marketplace.js";
import { handleRegistryInstall, handleRegistryUpdate } from "../../../src/api/handlers/registry.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database } from "../../../src/database/types.js";
import type { SandboxRunner } from "../../../src/plugins/sandbox/types.js";
import { PluginStateRepository } from "../../../src/plugins/state.js";
import { setDefaultRegistryArtifactTransport } from "../../../src/registry/artifact-fetch.js";
import { validateRegistryArtifact } from "../../../src/registry/artifact-verification.js";
import {
	readAuthoritativePackageRelease,
	verifyAuthoritativePackageRelease,
	type AuthoritativeRecordReadOptions,
} from "../../../src/registry/authoritative-records.js";
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

function createMemoryStorage(options?: { deferDeletes?: boolean }): Storage & {
	keys(): string[];
	releaseDeletes(): void;
} {
	const values = new Map<string, { body: Uint8Array; contentType: string }>();
	let deletesReleased = options?.deferDeletes !== true;
	const pendingDeletes: Array<() => void> = [];
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
			if (!deletesReleased) {
				await new Promise<void>((resolve) => pendingDeletes.push(resolve));
			}
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
		releaseDeletes() {
			deletesReleased = true;
			for (const resolve of pendingDeletes.splice(0)) resolve();
		},
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
	opts: {
		indexedAt?: string;
		historicalReleaseCount?: number;
		releaseHistoryComplete?: boolean;
	} = {},
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
		indexedAt: opts.indexedAt ?? "2026-01-01T00:00:00.000Z",
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
		...(opts.historicalReleaseCount === undefined
			? {}
			: { historicalReleaseCount: opts.historicalReleaseCount }),
		...(opts.releaseHistoryComplete === undefined
			? {}
			: { releaseHistoryComplete: opts.releaseHistoryComplete }),
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
		const fixture = await createDelegatedReleaseConformanceFixture({
			routes: [
				{
					name: "webhook",
					public: true,
					methods: ["POST"],
					request: { body: "bytes", headers: ["x-signature"] },
					response: "raw",
				},
			],
		});
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
				publicRoutes: ["webhook"],
				verification: {
					provenance: "verified",
					policy: { requireProvenance: true },
				},
			},
		});
		if (!preview.success) return;

		const missingRouteConsent = await handleRegistryInstall(
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
		expect(missingRouteConsent).toMatchObject({
			success: false,
			error: {
				code: "ROUTE_VISIBILITY_ESCALATION",
				details: { routeVisibilityChanges: { newlyPublic: ["webhook"] } },
			},
		});

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
				acknowledgedPublicRoutes: preview.data.publicRoutes,
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
			mcpToolsEnabled: false,
			mcpToolsConsent: null,
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

	it("installs the maximal registry fixture only after exact authority and public-route consent", async () => {
		const pluginDir = fileURLToPath(
			new URL("../../../../plugins/marketplace-test", import.meta.url),
		);
		const built = await buildPlugin({ dir: pluginDir });
		const manifest = JSON.parse(
			await readFile(built.files.manifestJson, "utf8"),
		) as import("@emdash-cms/plugin-types").PluginManifest;
		const backendCode = await readFile(built.files.runtime, "utf8");
		expect(backendCode).toContain('"body-json"');
		expect(backendCode.charCodeAt(0)).not.toBe(0x1f);
		const fixture = await createDelegatedReleaseConformanceFixture({
			manifest: { ...manifest, id: "gallery", version: "1.2.3" },
			backendCode,
		});
		expect(
			fixture.release.extensions["com.emdashcms.experimental.package.releaseExtension"]
				.declaredAccess,
		).toEqual(manifest.declaredAccess);
		const context = await createContext(fixture);
		await mockAggregator(fixture, context);
		artifactFetch(fixture.artifactBytes);
		const authoritative = await readAuthoritativePackageRelease(
			fixture.publisherDid,
			fixture.packageSlug,
			fixture.version,
			context.options,
		);
		if (!authoritative.success) throw new Error(authoritative.error.message);
		const recordReport = await verifyAuthoritativePackageRelease(
			authoritative.value,
			fixture.artifactDigest,
			context.options,
		);
		if (!recordReport.success) throw new Error(recordReport.reasons[0]?.message);
		expect(recordReport.value.declaredAccess).toEqual(
			canonicalizeDeclaredAccess(manifest.declaredAccess ?? {}),
		);
		const artifactReport = await validateRegistryArtifact(
			fixture.artifactBytes,
			fixture.artifactChecksum,
			fixture.packageSlug,
			fixture.version,
		);
		if (!artifactReport.success) throw new Error(artifactReport.error.message);
		expect(
			canonicalizeDeclaredAccess(artifactReport.value.bundle.manifest.declaredAccess ?? {}),
		).toEqual(recordReport.value.declaredAccess);

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
				capabilities: expect.arrayContaining(manifest.capabilities),
				publicRoutes: expect.arrayContaining(
					manifest.routes
						.filter((route) => typeof route !== "string" && route.public === true)
						.map((route) => (typeof route === "string" ? route : route.name)),
				),
			},
		});
		if (!preview.success) return;

		const noAuthorityConsent = await handleRegistryInstall(
			db,
			storage,
			sandbox,
			registryConfig,
			{
				did: fixture.publisherDid,
				slug: fixture.packageSlug,
				version: fixture.version,
				acknowledgedProfileCid: preview.data.verification.profileCid,
				acknowledgedReleaseCid: preview.data.verification.releaseCid,
			},
			{ authoritativeRecords: context.options },
		);
		expect(noAuthorityConsent).toMatchObject({
			success: false,
			error: { code: "DECLARED_ACCESS_REQUIRED" },
		});

		const noPublicRouteConsent = await handleRegistryInstall(
			db,
			storage,
			sandbox,
			registryConfig,
			{
				did: fixture.publisherDid,
				slug: fixture.packageSlug,
				version: fixture.version,
				acknowledgedDeclaredAccess: preview.data.capabilities,
				acknowledgedProfileCid: preview.data.verification.profileCid,
				acknowledgedReleaseCid: preview.data.verification.releaseCid,
			},
			{ authoritativeRecords: context.options },
		);
		expect(noPublicRouteConsent).toMatchObject({
			success: false,
			error: {
				code: "ROUTE_VISIBILITY_ESCALATION",
				details: { routeVisibilityChanges: { newlyPublic: preview.data.publicRoutes } },
			},
		});

		const noMcpConsent = await handleRegistryInstall(
			db,
			storage,
			sandbox,
			registryConfig,
			{
				did: fixture.publisherDid,
				slug: fixture.packageSlug,
				version: fixture.version,
				acknowledgedDeclaredAccess: preview.data.capabilities,
				acknowledgedPublicRoutes: preview.data.publicRoutes,
				acknowledgedProfileCid: preview.data.verification.profileCid,
				acknowledgedReleaseCid: preview.data.verification.releaseCid,
			},
			{ authoritativeRecords: context.options },
		);
		expect(noMcpConsent).toMatchObject({
			success: false,
			error: {
				code: "MCP_TOOL_CONSENT_REQUIRED",
				details: {
					mcpTools: [
						expect.objectContaining({ name: "runDiagnostics", destructive: false }),
						expect.objectContaining({ name: "deleteRecord", destructive: true }),
					],
				},
			},
		});

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
				acknowledgedPublicRoutes: preview.data.publicRoutes,
				acknowledgedProfileCid: preview.data.verification.profileCid,
				acknowledgedReleaseCid: preview.data.verification.releaseCid,
			},
			{ authoritativeRecords: context.options },
		);
		expect(installed).toMatchObject({ success: true });
		if (!installed.success) return;
		expect(await new PluginStateRepository(db).get(installed.data.pluginId)).toMatchObject({
			version: fixture.version,
			registryPublisherDid: fixture.publisherDid,
			registrySlug: fixture.packageSlug,
		});
		expect(storage.keys()).toEqual(
			expect.arrayContaining([
				`registry/${installed.data.pluginId}/${fixture.version}/backend.js`,
				`registry/${installed.data.pluginId}/${fixture.version}/manifest.json`,
			]),
		);
		const installedBundle = await loadBundleFromR2(
			storage,
			installed.data.pluginId,
			fixture.version,
			"registry",
		);
		expect(installedBundle).not.toBeNull();
		if (!installedBundle) return;
		expect(installedBundle.manifest.id).toBe(installed.data.pluginId);
		expect(installedBundle.backendCode).toBe(backendCode);
		vi.unstubAllGlobals();
		const installedRunner = new WorkerdSandboxRunner({ db });
		try {
			const installedPlugin = await installedRunner.load(
				installedBundle.manifest,
				installedBundle.backendCode,
			);
			const adminResponse = (await installedPlugin.invokeRoute(
				"admin",
				{ type: "page_load", page: "/overview" },
				{
					url: "https://plugin.test/admin",
					method: "POST",
					headers: { "content-type": "application/json" },
					ui: { surface: "admin-page", locale: "en", direction: "ltr" },
				},
			)) as { blocks: Array<{ type: string; url?: string }> };
			expect(adminResponse.blocks).toContainEqual(
				expect.objectContaining({
					type: "image",
					url: `/_emdash/api/plugins/${installed.data.pluginId}/fixture-image`,
				}),
			);
			await expect(
				installedPlugin.invokeRoute(
					"body-json",
					{ installed: true },
					{
						url: "https://plugin.test/body-json",
						method: "POST",
						headers: { "content-type": "application/json" },
					},
				),
			).resolves.toEqual({ input: { installed: true } });
		} finally {
			await installedRunner.terminateAll();
		}

		const next = await createDelegatedReleaseConformanceFixture({
			version: "1.2.4",
			manifest: {
				...manifest,
				id: "gallery",
				version: "1.2.4",
				routes: [...manifest.routes, { name: "post-install-public", public: true }],
			},
			backendCode,
		});
		await context.publisher.repo.putRecord(
			"com.emdashcms.experimental.package.release",
			`${next.packageSlug}:${next.version}`,
			next.release,
		);
		const nextOptions: AuthoritativeRecordReadOptions = {
			...context.options,
			provenanceFetch: async () => new Response(next.provenanceDocument),
			provenanceVerifier: next.provenanceVerifier,
		};
		await mockAggregator(next, context);
		artifactFetch(next.artifactBytes);

		const updatePreflight = await handleRegistryUpdate(
			db,
			storage,
			sandbox,
			registryConfig,
			installed.data.pluginId,
			{ authoritativeRecords: nextOptions },
		);
		expect(updatePreflight).toMatchObject({
			success: false,
			error: {
				code: "ROUTE_VISIBILITY_ESCALATION",
				details: { routeVisibilityChanges: { newlyPublic: ["post-install-public"] } },
			},
		});
		if (updatePreflight.success) return;
		const updateVerification = Reflect.get(updatePreflight.error.details ?? {}, "verification");
		if (!updateVerification || typeof updateVerification !== "object") {
			throw new Error("Missing update verification");
		}
		const profileCid = Reflect.get(updateVerification, "profileCid");
		const releaseCid = Reflect.get(updateVerification, "releaseCid");
		if (typeof profileCid !== "string" || typeof releaseCid !== "string") {
			throw new Error("Invalid update verification");
		}

		artifactFetch(next.artifactBytes);
		const updated = await handleRegistryUpdate(
			db,
			storage,
			sandbox,
			registryConfig,
			installed.data.pluginId,
			{
				authoritativeRecords: nextOptions,
				acknowledgedPublicRoutes: ["post-install-public"],
				acknowledgedProfileCid: profileCid,
				acknowledgedReleaseCid: releaseCid,
			},
		);
		expect(updated).toMatchObject({
			success: true,
			data: { oldVersion: fixture.version, newVersion: next.version },
		});
		expect(await new PluginStateRepository(db).get(installed.data.pluginId)).toMatchObject({
			version: next.version,
		});
		const updatedBundle = await loadBundleFromR2(
			storage,
			installed.data.pluginId,
			next.version,
			"registry",
		);
		expect(updatedBundle).not.toBeNull();
		if (!updatedBundle) return;
		vi.unstubAllGlobals();
		const updatedRunner = new WorkerdSandboxRunner({ db });
		try {
			const updatedPlugin = await updatedRunner.load(
				updatedBundle.manifest,
				updatedBundle.backendCode,
			);
			await expect(
				updatedPlugin.invokeRoute(
					"body-json",
					{ updated: true },
					{
						url: "https://plugin.test/body-json",
						method: "POST",
						headers: { "content-type": "application/json" },
					},
				),
			).resolves.toEqual({ input: { updated: true } });
		} finally {
			await updatedRunner.terminateAll();
		}
	}, 30_000);

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

	it("exempts a proven first release from the configured holdback", async () => {
		const fixture = await createDelegatedReleaseConformanceFixture();
		const context = await createContext(fixture);
		await mockAggregator(fixture, context, {
			indexedAt: new Date().toISOString(),
			historicalReleaseCount: 1,
			releaseHistoryComplete: true,
		});
		artifactFetch(fixture.artifactBytes);

		const result = await handleRegistryInstall(
			db,
			storage,
			sandbox,
			{
				...registryConfig,
				policy: { minimumReleaseAge: "48h" },
			},
			{ did: fixture.publisherDid, slug: fixture.packageSlug, version: fixture.version },
			{ verifyOnly: true, authoritativeRecords: context.options },
		);

		expect(result).toMatchObject({ success: true });
	});

	it.each([
		["missing history evidence", {}],
		["incomplete history", { historicalReleaseCount: 1, releaseHistoryComplete: false }],
		["an earlier release", { historicalReleaseCount: 2, releaseHistoryComplete: true }],
	])("holds back a new release with %s", async (_name, history) => {
		const fixture = await createDelegatedReleaseConformanceFixture();
		const context = await createContext(fixture);
		await mockAggregator(fixture, context, {
			indexedAt: new Date().toISOString(),
			...history,
		});

		const result = await handleRegistryInstall(
			db,
			storage,
			sandbox,
			{
				...registryConfig,
				policy: { minimumReleaseAge: "48h" },
			},
			{ did: fixture.publisherDid, slug: fixture.packageSlug, version: fixture.version },
			{ verifyOnly: true, authoritativeRecords: context.options },
		);

		expect(result).toMatchObject({
			success: false,
			error: { code: "RELEASE_TOO_NEW" },
		});
	});

	it("updates with CID-bound re-consent and keeps a concurrent downgrade bundle active", async () => {
		storage = createMemoryStorage({ deferDeletes: true });
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
			declaredAccess: { content: { read: {} }, comments: { moderate: {} } },
			routes: [{ name: "webhook", public: true }],
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
					capabilityChanges: { added: ["comments:moderate", "comments:read"] },
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

		const routePreflight = await handleRegistryUpdate(
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
		expect(routePreflight).toMatchObject({
			success: false,
			error: {
				code: "ROUTE_VISIBILITY_ESCALATION",
				details: { routeVisibilityChanges: { newlyPublic: ["webhook"] } },
			},
		});

		const staleConsent = await handleRegistryUpdate(
			db,
			storage,
			sandbox,
			registryConfig,
			installed.data.pluginId,
			{
				authoritativeRecords: nextOptions,
				confirmCapabilityChanges: true,
				acknowledgedPublicRoutes: ["different-route"],
				acknowledgedProfileCid: profileCid,
				acknowledgedReleaseCid: releaseCid,
			},
		);
		expect(staleConsent).toMatchObject({
			success: false,
			error: {
				code: "ROUTE_VISIBILITY_ESCALATION",
				details: { routeVisibilityChanges: { newlyPublic: ["webhook"] } },
			},
		});

		const updated = await handleRegistryUpdate(
			db,
			storage,
			sandbox,
			registryConfig,
			installed.data.pluginId,
			{
				authoritativeRecords: nextOptions,
				confirmCapabilityChanges: true,
				acknowledgedPublicRoutes: ["webhook"],
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
		expect(storage.keys()).toEqual(
			expect.arrayContaining([
				`registry/${installed.data.pluginId}/${initial.version}/manifest.json`,
				`registry/${installed.data.pluginId}/${next.version}/manifest.json`,
			]),
		);

		const retried = await handleRegistryUpdate(
			db,
			storage,
			sandbox,
			registryConfig,
			installed.data.pluginId,
			{ authoritativeRecords: nextOptions },
		);
		expect(retried).toMatchObject({
			success: false,
			error: { code: "ALREADY_UP_TO_DATE" },
		});
		expect(storage.keys()).toContain(
			`registry/${installed.data.pluginId}/${next.version}/manifest.json`,
		);

		await mockAggregator(initial, context);
		artifactFetch(initial.artifactBytes);
		const downgraded = await handleRegistryUpdate(
			db,
			storage,
			sandbox,
			registryConfig,
			installed.data.pluginId,
			{ authoritativeRecords: context.options },
		);
		expect(downgraded).toMatchObject({
			success: true,
			data: { oldVersion: next.version, newVersion: initial.version },
		});

		storage.releaseDeletes();
		await new Promise((resolve) => setImmediate(resolve));
		await new Promise((resolve) => setImmediate(resolve));

		expect(await new PluginStateRepository(db).get(installed.data.pluginId)).toMatchObject({
			version: initial.version,
		});
		expect(storage.keys()).toEqual(
			expect.arrayContaining([
				`registry/${installed.data.pluginId}/${initial.version}/backend.js`,
				`registry/${installed.data.pluginId}/${initial.version}/manifest.json`,
			]),
		);
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
