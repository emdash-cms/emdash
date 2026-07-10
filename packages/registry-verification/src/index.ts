export {
	compareDigestBytes,
	computeMultihash,
	decodeMultihash,
	verifyMultihash,
} from "./checksum.js";
export { DEFAULT_FETCH_LIMITS, fetchVerifiedResource } from "./fetch.js";
export type { DecodedMultihash, MultihashAlgorithm } from "./checksum.js";
export type {
	FetchImplementation,
	FetchVerifiedResourceOptions,
	HostnameResolver,
	VerifiedResource,
} from "./fetch.js";
export type { VerificationError, VerificationErrorCode, VerificationResult } from "./errors.js";
