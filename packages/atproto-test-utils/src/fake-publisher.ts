/**
 * High-level test publisher. Wires up a FakeRepo, registers it with a MockPds
 * and a MockDidResolver, and exposes ergonomic helpers for the EmDash
 * registry record types (profile + release).
 *
 * Typical use:
 *
 * ```ts
 * const fixture = createFakePublisherFixture();
 * const alice = await fixture.createPublisher({ did: "did:plc:alice", handle: "alice.test" });
 * await alice.publishProfile({ slug: "foo", license: "MIT", securityEmail: "x@y.test" });
 * await alice.publishRelease({ slug: "foo", version: "1.0.0", checksum: "...", url: "..." });
 *
 * // Now the aggregator can fetch from fixture.pds, verify against
 * // fixture.didResolver, and ingest events from fixture.jetstream.
 * ```
 */

import { parseDidKey } from "@atproto/crypto";

import { FakeRepo, type FakeRepoOptions } from "./fake-repo.js";

const DID_KEY_PREFIX_RE = /^did:key:/;
import { MockDidResolver, buildDidDocument } from "./mock-did-resolver.js";
import { MockJetstream } from "./mock-jetstream.js";
import { MockPds } from "./mock-pds.js";
import { PROFILE_NSID, RELEASE_NSID } from "./nsid.js";
import type { AtprotoDid } from "./types.js";

export { PROFILE_NSID, RELEASE_NSID } from "./nsid.js";

export interface FakePublisherOptions extends FakeRepoOptions {
	handle?: string;
	pdsBaseUrl?: string;
}

export interface PublishProfileOptions {
	slug: string;
	license: string;
	authors?: Array<{ name: string; url?: string; email?: string }>;
	securityEmail?: string;
	securityUrl?: string;
}

export interface PublishReleaseOptions {
	slug: string;
	version: string;
	checksum: string;
	url: string;
	declaredAccess?: Record<string, unknown>;
}

export class FakePublisher {
	readonly repo: FakeRepo;
	readonly handle?: string;

	private constructor(repo: FakeRepo, handle?: string) {
		this.repo = repo;
		this.handle = handle;
	}

	static async create(repo: FakeRepo, handle?: string): Promise<FakePublisher> {
		return new FakePublisher(repo, handle);
	}

	get did(): AtprotoDid {
		return this.repo.did;
	}

	async publishProfile(opts: PublishProfileOptions): Promise<{ rkey: string }> {
		// The lexicon (com.emdashcms.experimental.package.profile) requires
		// `authors` minLength: 1 and `security` minLength: 1. Defaulting to
		// empty arrays would let test fixtures silently produce
		// lexicon-invalid records that pass today (no validator runs) but
		// would fail the moment a real validator does. Enforce both
		// invariants in the helper instead.
		const security: Array<Record<string, string>> = [];
		if (opts.securityEmail) security.push({ email: opts.securityEmail });
		if (opts.securityUrl) security.push({ url: opts.securityUrl });
		if (security.length === 0) {
			throw new Error(
				"publishProfile: pass at least one of securityEmail or securityUrl. " +
					"The profile lexicon requires `security` minLength: 1.",
			);
		}
		const authors = opts.authors ?? [{ name: this.handle ?? "Test Publisher" }];
		if (authors.length === 0) {
			throw new Error(
				"publishProfile: `authors` cannot be empty. The profile lexicon requires minLength: 1.",
			);
		}
		const value: Record<string, unknown> = {
			$type: PROFILE_NSID,
			id: `at://${this.repo.did}/${PROFILE_NSID}/${opts.slug}`,
			slug: opts.slug,
			type: "emdash-plugin",
			license: opts.license,
			authors,
			security,
			lastUpdated: new Date().toISOString(),
		};
		await this.repo.putRecord(PROFILE_NSID, opts.slug, value);
		return { rkey: opts.slug };
	}

	async publishRelease(opts: PublishReleaseOptions): Promise<{ rkey: string }> {
		const rkey = `${opts.slug}:${opts.version}`;
		const value: Record<string, unknown> = {
			$type: RELEASE_NSID,
			package: opts.slug,
			version: opts.version,
			artifacts: {
				package: {
					url: opts.url,
					checksum: opts.checksum,
					contentType: "application/gzip",
				},
			},
			extensions: {
				"com.emdashcms.experimental.package.releaseExtension": {
					$type: "com.emdashcms.experimental.package.releaseExtension",
					declaredAccess: opts.declaredAccess ?? {},
				},
			},
		};
		await this.repo.putRecord(RELEASE_NSID, rkey, value);
		return { rkey };
	}
}

/**
 * One-stop test fixture: a MockPds, MockDidResolver, and MockJetstream that
 * already know about each other. Every publisher created via the fixture is
 * registered with all three.
 */
export interface FakePublisherFixture {
	pds: MockPds;
	didResolver: MockDidResolver;
	jetstream: MockJetstream;
	pdsBaseUrl: string;
	createPublisher(opts: FakePublisherOptions): Promise<FakePublisher>;
}

export interface CreateFakePublisherFixtureOptions {
	pdsBaseUrl?: string;
}

export function createFakePublisherFixture(
	opts: CreateFakePublisherFixtureOptions = {},
): FakePublisherFixture {
	const pds = new MockPds();
	const didResolver = new MockDidResolver();
	const jetstream = new MockJetstream();
	const pdsBaseUrl = opts.pdsBaseUrl ?? "https://pds.mock.test";

	return {
		pds,
		didResolver,
		jetstream,
		pdsBaseUrl,
		async createPublisher(publisherOpts): Promise<FakePublisher> {
			const repo = await FakeRepo.create(publisherOpts);
			pds.mount(repo);
			// `keypair.did()` returns "did:key:z<multikey>". The DID-document
			// `publicKeyMultibase` field is just the multikey portion — drop
			// the `did:key:` prefix.
			const didKey = repo.didKey();
			const signingKeyMultibase = didKey.replace(DID_KEY_PREFIX_RE, "");
			const doc = buildDidDocument({
				did: repo.did,
				signingKeyMultibase,
				pdsEndpoint: publisherOpts.pdsBaseUrl ?? pdsBaseUrl,
				handle: publisherOpts.handle,
			});
			didResolver.register(repo.did, doc);
			return FakePublisher.create(repo, publisherOpts.handle);
		},
	};
}

/**
 * Returns a `did:key`-style public key from the publisher's DID, suitable
 * for direct verification with `@atcute/repo`'s `verifyRecord({ publicKey })`.
 * The aggregator normally resolves DID documents and reads the multikey out;
 * tests that exercise the verification primitive directly can short-circuit
 * via this helper.
 */
export function publisherDidKey(repo: FakeRepo): string {
	return repo.didKey();
}

/**
 * Re-export `parseDidKey` so tests can convert the publisher's DID key string
 * into the `{ jwtAlg, keyBytes }` shape `@atcute/crypto` needs.
 */
export { parseDidKey };
