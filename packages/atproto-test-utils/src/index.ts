/**
 * In-memory atproto fakes for EmDash tests.
 *
 * Designed so the aggregator's verification + ingest paths exercise the same
 * code in tests as in production: every record is signed with a real keypair,
 * the PDS returns CARs containing real MST proofs, and the verifier
 * (@atcute/repo's `verifyRecord`) walks them as it would for a real PDS.
 *
 * The mocks compose:
 *   - `FakeRepo` is one DID's signed repo (built on `@atproto/repo`).
 *   - `MockPds` hosts many `FakeRepo`s and serves the XRPC endpoints the
 *     aggregator calls.
 *   - `MockDidResolver` returns DID documents pointing at the MockPds and
 *     carrying the publisher's signing key.
 *   - `MockJetstream` is a driveable async iterable of commit events; tests
 *     emit events to drive the records DO.
 *   - `createFakePublisherFixture()` wires the three together.
 */

export { FakeRepo, type FakeRepoOptions } from "./fake-repo.js";
export { MockPds } from "./mock-pds.js";
export {
	MockDidResolver,
	buildDidDocument,
	type BuildDidDocumentOptions,
	type DidDocument,
} from "./mock-did-resolver.js";
export {
	MockJetstream,
	type JetstreamCommitEvent,
	type JetstreamEvent,
	type MockJetstreamSubscribeOptions,
	type MockJetstreamSubscription,
} from "./mock-jetstream.js";
export {
	FakePublisher,
	PROFILE_NSID,
	RELEASE_NSID,
	createFakePublisherFixture,
	publisherDidKey,
	parseDidKey,
	type CreateFakePublisherFixtureOptions,
	type FakePublisherFixture,
	type FakePublisherOptions,
	type PublishProfileOptions,
	type PublishReleaseOptions,
} from "./fake-publisher.js";
export type { AtprotoDid } from "./types.js";
