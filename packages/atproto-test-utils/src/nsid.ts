/**
 * NSID constants. Split from `fake-publisher.ts` so they can be imported in
 * Worker test contexts (workerd) without pulling in `@atproto/repo` and its
 * Node-crypto dependencies.
 */

export const PROFILE_NSID = "com.emdashcms.experimental.package.profile";
export const RELEASE_NSID = "com.emdashcms.experimental.package.release";
