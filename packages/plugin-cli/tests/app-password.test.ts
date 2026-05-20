/**
 * App-password publishing tests (RFC: see `.claude/REGISTRY_APP_PASSWORD_PLAN.md`).
 *
 * Three layers of coverage:
 *
 *   1. Provider behaviour — `createAppPasswordAuth` against the mock PDS:
 *      end-to-end happy paths for handle + DID identifiers, plus every
 *      guardrail (format, full-account scope, DID cross-check).
 *   2. Selection — `selectPublishAuth` precedence rules between
 *      `--publisher`, `EMDASH_PUBLISHER_DID`, `EMDASH_PUBLISHER_HANDLE`, and
 *      `EMDASH_PUBLISHER_APP_PASSWORD`. Pure logic, env passed explicitly.
 *   3. Integration regression — `runPublish` under app-password auth still
 *      enforces the manifest `publisher` pin against the logged-in DID.
 *
 * The resolver is injected (not stubbed via module mocking) so identifier →
 * `{ did, pds }` never hits the network. The CredentialManager's `fetch` is
 * pointed at the mock PDS so `createSession` round-trips end-to-end without a
 * real atproto server.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ActorResolver, ResolvedActor } from "@atcute/identity-resolver";
import { PublishingClient } from "@emdash-cms/registry-client";
import { NSID } from "@emdash-cms/registry-lexicons";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	AppPasswordError,
	createAppPasswordAuth,
	type PublishAuth,
	selectPublishAuth,
} from "../src/app-password.js";
import { runPublish } from "../src/commands/publish.js";
import { publishRelease, type ProfileBootstrap } from "../src/publish/api.js";
import { MockPds } from "./mock-pds.js";

const TEST_DID = "did:plc:appPasswordTest" as const;
const TEST_HANDLE = "publisher.test";
const TEST_PDS = "http://mock.test";
const VALID_APP_PASSWORD = "aaaa-bbbb-cccc-dddd";

const validProfile: ProfileBootstrap = {
	license: "MIT",
	authorName: "Alice",
	securityEmail: "security@example.com",
};

/**
 * Wire a CredentialManager-shaped fetch at a MockPds. The CredentialManager
 * issues full-URL requests (`http://mock.test/xrpc/...`); the mock keys on
 * pathname, so we strip the host.
 */
function pdsFetch(pds: MockPds): typeof globalThis.fetch {
	return async (input, init) => {
		const target =
			typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
		const url = new URL(target);
		return pds.handle(url.pathname + url.search, init ?? {});
	};
}

function fakeResolver(resolved: ResolvedActor): ActorResolver {
	return { resolve: async () => resolved };
}

function defaultResolved(overrides: Partial<ResolvedActor> = {}): ResolvedActor {
	return {
		did: TEST_DID,
		handle: TEST_HANDLE,
		pds: TEST_PDS,
		...overrides,
	};
}

describe("createAppPasswordAuth", () => {
	describe("happy path", () => {
		it("identifies with a handle, publishes through the authenticated handler", async () => {
			const pds = new MockPds({ did: TEST_DID });
			const auth = createAppPasswordAuth({
				identifier: TEST_HANDLE,
				password: VALID_APP_PASSWORD,
				actorResolver: fakeResolver(defaultResolved()),
				fetch: pdsFetch(pds),
			});

			const identity = await auth.identify();
			expect(identity.did).toBe(TEST_DID);
			expect(identity.handle).toBe("mock.test");
			expect(identity.pds).toBe(TEST_PDS);

			const handler = await auth.handler();
			const publisher = PublishingClient.fromHandler({
				handler,
				did: identity.did,
				pds: identity.pds,
			});
			const result = await publishRelease({
				publisher,
				did: identity.did,
				manifest: {
					id: "test-plugin",
					version: "1.0.0",
					capabilities: [],
					allowedHosts: [],
					storage: {},
					hooks: [],
					routes: [],
					admin: {},
				},
				checksum: "bciqtestchecksum",
				url: "https://example.com/test-plugin-1.0.0.tar.gz",
				profile: validProfile,
			});

			expect(result.profileCreated).toBe(true);
			expect(result.releaseUri).toBe(`at://${TEST_DID}/${NSID.packageRelease}/test-plugin:1.0.0`);
			expect(pds.callsTo("com.atproto.server.createSession")).toHaveLength(1);
		});

		it("identifies with a DID, publishes through the authenticated handler", async () => {
			const pds = new MockPds({ did: TEST_DID });
			const auth = createAppPasswordAuth({
				identifier: TEST_DID,
				password: VALID_APP_PASSWORD,
				actorResolver: fakeResolver(defaultResolved()),
				fetch: pdsFetch(pds),
			});
			const identity = await auth.identify();
			expect(identity.did).toBe(TEST_DID);

			const handler = await auth.handler();
			const publisher = PublishingClient.fromHandler({
				handler,
				did: identity.did,
				pds: identity.pds,
			});
			const result = await publishRelease({
				publisher,
				did: identity.did,
				manifest: {
					id: "test-plugin",
					version: "1.0.0",
					capabilities: [],
					allowedHosts: [],
					storage: {},
					hooks: [],
					routes: [],
					admin: {},
				},
				checksum: "bciqtestchecksum",
				url: "https://example.com/test-plugin-1.0.0.tar.gz",
				profile: validProfile,
			});
			expect(result.profileCreated).toBe(true);
		});
	});

	describe("guardrails", () => {
		it("rejects a malformed app-password without ever attempting login", async () => {
			const pds = new MockPds({ did: TEST_DID });
			expect(() =>
				createAppPasswordAuth({
					identifier: TEST_HANDLE,
					password: "not-an-app-password",
					actorResolver: fakeResolver(defaultResolved()),
					fetch: pdsFetch(pds),
				}),
			).toThrowError(
				expect.objectContaining({
					name: "AppPasswordError",
					code: "APP_PASSWORD_FORMAT",
				}),
			);
			expect(pds.calls).toHaveLength(0);
		});

		it("rejects email-shaped identifiers up front (no createSession call)", async () => {
			const pds = new MockPds({ did: TEST_DID });
			expect(() =>
				createAppPasswordAuth({
					identifier: "alice@example.com",
					password: VALID_APP_PASSWORD,
					actorResolver: fakeResolver(defaultResolved()),
					fetch: pdsFetch(pds),
				}),
			).toThrowError(/not a valid handle or DID/);
			expect(pds.calls).toHaveLength(0);
		});

		it("refuses a full-account `com.atproto.access` scope (FULL_ACCOUNT_CREDENTIAL)", async () => {
			const pds = new MockPds({
				did: TEST_DID,
				createSessionScope: "com.atproto.access",
			});
			const auth = createAppPasswordAuth({
				identifier: TEST_HANDLE,
				password: VALID_APP_PASSWORD,
				actorResolver: fakeResolver(defaultResolved()),
				fetch: pdsFetch(pds),
			});
			await expect(auth.identify()).rejects.toMatchObject({
				name: "AppPasswordError",
				code: "FULL_ACCOUNT_CREDENTIAL",
			});
			// applyWrites must not have been reachable; createSession ran but
			// nothing past it.
			expect(pds.callsTo("com.atproto.repo.applyWrites")).toHaveLength(0);
		});

		it("accepts the privileged app-password scope", async () => {
			const pds = new MockPds({
				did: TEST_DID,
				createSessionScope: "com.atproto.appPassPrivileged",
			});
			const auth = createAppPasswordAuth({
				identifier: TEST_HANDLE,
				password: VALID_APP_PASSWORD,
				actorResolver: fakeResolver(defaultResolved()),
				fetch: pdsFetch(pds),
			});
			const identity = await auth.identify();
			expect(identity.did).toBe(TEST_DID);
		});

		it("refuses when the login DID disagrees with the resolved identifier DID", async () => {
			const pds = new MockPds({
				did: TEST_DID,
				// Resolver claims the identifier points at TEST_DID, but the PDS
				// authenticates as a different repo. A real attacker scenario
				// is identifier spoofing (DNS-rebinding the handle->DID step)
				// or a publisher who pointed two handles at the same app
				// password.
				createSessionDid: "did:plc:otherAccount",
			});
			const auth = createAppPasswordAuth({
				identifier: TEST_HANDLE,
				password: VALID_APP_PASSWORD,
				actorResolver: fakeResolver(defaultResolved()),
				fetch: pdsFetch(pds),
			});
			await expect(auth.identify()).rejects.toMatchObject({
				name: "AppPasswordError",
				code: "PUBLISHER_DID_MISMATCH",
			});
		});

		it("caches the manager so identify() + handler() never re-login", async () => {
			const pds = new MockPds({ did: TEST_DID });
			const auth = createAppPasswordAuth({
				identifier: TEST_HANDLE,
				password: VALID_APP_PASSWORD,
				actorResolver: fakeResolver(defaultResolved()),
				fetch: pdsFetch(pds),
			});
			await auth.identify();
			await auth.identify();
			await auth.handler();
			expect(pds.callsTo("com.atproto.server.createSession")).toHaveLength(1);
		});

		it("shares the in-flight login between concurrent callers", async () => {
			// Cache the in-flight promise rather than the resolved value: two
			// callers entering identify() before the first createSession
			// settles must share one round trip, not race into two.
			const pds = new MockPds({ did: TEST_DID });
			const auth = createAppPasswordAuth({
				identifier: TEST_HANDLE,
				password: VALID_APP_PASSWORD,
				actorResolver: fakeResolver(defaultResolved()),
				fetch: pdsFetch(pds),
			});
			await Promise.all([auth.identify(), auth.identify(), auth.handler()]);
			expect(pds.callsTo("com.atproto.server.createSession")).toHaveLength(1);
		});

		it("handler() works without an explicit prior identify() call", async () => {
			// handler() and identify() are independent entry points into the
			// same login flow. Production runPublish calls identify() first,
			// but the provider contract should not require that ordering.
			const pds = new MockPds({ did: TEST_DID });
			const auth = createAppPasswordAuth({
				identifier: TEST_HANDLE,
				password: VALID_APP_PASSWORD,
				actorResolver: fakeResolver(defaultResolved()),
				fetch: pdsFetch(pds),
			});
			const handler = await auth.handler();
			expect(handler).toBeDefined();
			expect(pds.callsTo("com.atproto.server.createSession")).toHaveLength(1);
		});

		it("trims whitespace before sending the identifier to createSession", async () => {
			// A stray space in EMDASH_PUBLISHER_HANDLE (CI YAML quoting
			// mistake) shouldn't reach the PDS as a leading whitespace
			// character.
			const pds = new MockPds({ did: TEST_DID });
			const auth = createAppPasswordAuth({
				identifier: `  ${TEST_HANDLE}  `,
				password: VALID_APP_PASSWORD,
				actorResolver: fakeResolver(defaultResolved()),
				fetch: pdsFetch(pds),
			});
			await auth.identify();
			const call = pds.callsTo("com.atproto.server.createSession")[0];
			expect(call?.body).toMatchObject({ identifier: TEST_HANDLE });
		});

		it("classifies transient runtime errors at exit 1, user-config errors at exit 2", () => {
			// CI scripts that branch on exit code would misclassify a DNS blip
			// or PDS outage if INVALID_PUBLISHER / APP_PASSWORD_LOGIN_FAILED
			// got the user-config exit code.
			expect(new AppPasswordError("APP_PASSWORD_LOGIN_FAILED", "x").exitCode).toBe(1);
			expect(new AppPasswordError("INVALID_PUBLISHER", "x").exitCode).toBe(1);
			expect(new AppPasswordError("FULL_ACCOUNT_CREDENTIAL", "x").exitCode).toBe(1);
			expect(new AppPasswordError("PUBLISHER_DID_MISMATCH", "x").exitCode).toBe(1);
			expect(new AppPasswordError("APP_PASSWORD_FORMAT", "x").exitCode).toBe(2);
			expect(new AppPasswordError("MISSING_APP_PASSWORD", "x").exitCode).toBe(2);
			expect(new AppPasswordError("MISSING_PUBLISHER", "x").exitCode).toBe(2);
		});
	});
});

describe("selectPublishAuth", () => {
	const oauthSentinel: PublishAuth = {
		async identify() {
			throw new Error("oauth sentinel identify() should not be called");
		},
		async handler() {
			throw new Error("oauth sentinel handler() should not be called");
		},
	};
	const oauthFactory = () => oauthSentinel;

	it("returns the OAuth provider when no env and no flag are present", () => {
		const auth = selectPublishAuth({}, { env: {}, oauthFactory });
		expect(auth).toBe(oauthSentinel);
	});

	it("--publisher takes precedence over EMDASH_PUBLISHER_HANDLE", async () => {
		const pds = new MockPds({ did: TEST_DID });
		let resolvedIdentifier: string | undefined;
		const resolver: ActorResolver = {
			resolve: async (actor) => {
				resolvedIdentifier = actor;
				return defaultResolved();
			},
		};
		const auth = selectPublishAuth(
			{ publisher: TEST_HANDLE },
			{
				env: {
					EMDASH_PUBLISHER_APP_PASSWORD: VALID_APP_PASSWORD,
					EMDASH_PUBLISHER_HANDLE: "ignored.example",
				},
				oauthFactory,
				actorResolver: resolver,
				fetch: pdsFetch(pds),
			},
		);
		await auth.identify();
		expect(resolvedIdentifier).toBe(TEST_HANDLE);
	});

	it("EMDASH_PUBLISHER_DID takes precedence over EMDASH_PUBLISHER_HANDLE", async () => {
		const pds = new MockPds({ did: TEST_DID });
		let resolvedIdentifier: string | undefined;
		const resolver: ActorResolver = {
			resolve: async (actor) => {
				resolvedIdentifier = actor;
				return defaultResolved();
			},
		};
		const auth = selectPublishAuth(
			{},
			{
				env: {
					EMDASH_PUBLISHER_APP_PASSWORD: VALID_APP_PASSWORD,
					EMDASH_PUBLISHER_DID: TEST_DID,
					EMDASH_PUBLISHER_HANDLE: "ignored.example",
				},
				oauthFactory,
				actorResolver: resolver,
				fetch: pdsFetch(pds),
			},
		);
		await auth.identify();
		expect(resolvedIdentifier).toBe(TEST_DID);
	});

	it("identifier without app password fails with MISSING_APP_PASSWORD (no fallback to OAuth)", () => {
		expect(() =>
			selectPublishAuth({ publisher: TEST_HANDLE }, { env: {}, oauthFactory }),
		).toThrowError(
			expect.objectContaining({
				name: "AppPasswordError",
				code: "MISSING_APP_PASSWORD",
			}),
		);
	});

	it('treats `--publisher=""` as absent and falls through to env identifiers', async () => {
		// `??` would otherwise short-circuit on the empty string and prevent
		// the env fallback. A user explicitly passing an empty `--publisher=`
		// expects the env identifier to take over, not to fail with a confusing
		// MISSING_PUBLISHER about an empty value.
		const pds = new MockPds({ did: TEST_DID });
		let resolvedIdentifier: string | undefined;
		const resolver: ActorResolver = {
			resolve: async (actor) => {
				resolvedIdentifier = actor;
				return defaultResolved();
			},
		};
		const auth = selectPublishAuth(
			{ publisher: "" },
			{
				env: {
					EMDASH_PUBLISHER_APP_PASSWORD: VALID_APP_PASSWORD,
					EMDASH_PUBLISHER_DID: TEST_DID,
				},
				oauthFactory,
				actorResolver: resolver,
				fetch: pdsFetch(pds),
			},
		);
		await auth.identify();
		expect(resolvedIdentifier).toBe(TEST_DID);
	});

	it("treats whitespace-only env values as absent", () => {
		// A stray space in a CI YAML (`EMDASH_PUBLISHER_HANDLE: " "`) shouldn't
		// latch as an identifier and trigger MISSING_APP_PASSWORD when no
		// password is set — that misclassifies the failure.
		const auth = selectPublishAuth({}, { env: { EMDASH_PUBLISHER_HANDLE: "   " }, oauthFactory });
		expect(auth).toBe(oauthSentinel);
	});

	it("app password without identifier fails with MISSING_PUBLISHER", () => {
		expect(() =>
			selectPublishAuth(
				{},
				{ env: { EMDASH_PUBLISHER_APP_PASSWORD: VALID_APP_PASSWORD }, oauthFactory },
			),
		).toThrowError(
			expect.objectContaining({
				name: "AppPasswordError",
				code: "MISSING_PUBLISHER",
			}),
		);
	});
});

describe("runPublish under app-password auth", () => {
	let workspace: string;

	beforeEach(async () => {
		workspace = await mkdtemp(join(tmpdir(), "emdash-app-pw-"));
	});

	afterEach(async () => {
		await rm(workspace, { recursive: true, force: true });
	});

	async function writeManifest(publisherPin: string): Promise<string> {
		const path = join(workspace, "emdash-plugin.jsonc");
		await mkdir(workspace, { recursive: true });
		await writeFile(
			path,
			JSON.stringify({
				slug: "test-plugin",
				version: "1.0.0",
				license: "MIT",
				publisher: publisherPin,
				author: { name: "Alice" },
				security: { email: "security@example.com" },
				capabilities: ["content:read"],
				allowedHosts: [],
			}),
		);
		return path;
	}

	it("manifest `publisher` pin still fires when identify() resolves to a different DID", async () => {
		const manifestPath = await writeManifest("did:plc:pinnedDifferentAccount");
		const pds = new MockPds({ did: TEST_DID });
		const auth = createAppPasswordAuth({
			identifier: TEST_HANDLE,
			password: VALID_APP_PASSWORD,
			actorResolver: fakeResolver(defaultResolved()),
			fetch: pdsFetch(pds),
		});

		await expect(
			runPublish(
				{
					url: "https://example.com/test-plugin-1.0.0.tar.gz",
					manifest: manifestPath,
				},
				{ auth },
			),
		).rejects.toMatchObject({
			name: "CliError",
			code: "MANIFEST_PUBLISHER_MISMATCH",
		});

		// Pin check fires AFTER identify() (login ran) but BEFORE any tarball
		// fetch (no records ever written).
		expect(pds.callsTo("com.atproto.server.createSession")).toHaveLength(1);
		expect(pds.callsTo("com.atproto.repo.applyWrites")).toHaveLength(0);
	});
});
