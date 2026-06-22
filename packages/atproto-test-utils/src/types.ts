/** Shared types used across the test-util mocks. */

/**
 * Atproto DID. Restricted to `did:plc:` and `did:web:` to match the verifier's
 * expectation (`@atcute/repo`'s `verifyRecord` parameter type). Re-exported
 * from `@atcute/lexicons/syntax` so the test fakes and the production
 * verifier agree on shape.
 */
export type { AtprotoDid } from "@atcute/lexicons/syntax";
