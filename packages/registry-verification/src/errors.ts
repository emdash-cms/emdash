/** Stable, machine-readable failures returned by this package. */
export type VerificationErrorCode =
	| "BUNDLE_COMPRESSED_SIZE_EXCEEDED"
	| "BUNDLE_DECOMPRESSED_SIZE_EXCEEDED"
	| "BUNDLE_FILE_COUNT_EXCEEDED"
	| "BUNDLE_FILE_SIZE_EXCEEDED"
	| "BUNDLE_ID_MISMATCH"
	| "BUNDLE_INVALID_ARCHIVE"
	| "BUNDLE_INVALID_MANIFEST"
	| "BUNDLE_INVALID_PATH"
	| "BUNDLE_MISSING_BACKEND"
	| "BUNDLE_MISSING_MANIFEST"
	| "BUNDLE_PATH_COLLISION"
	| "BUNDLE_UNSUPPORTED_ENTRY"
	| "BUNDLE_VERSION_MISMATCH"
	| "CHECKSUM_MISMATCH"
	| "FETCH_FAILED"
	| "HOST_REJECTED"
	| "INVALID_MULTIHASH"
	| "INVALID_URL"
	| "REDIRECT_LIMIT_EXCEEDED"
	| "REDIRECT_LOCATION_MISSING"
	| "RESOURCE_SIZE_EXCEEDED"
	| "RESOURCE_STATUS_ERROR"
	| "RESOURCE_TIMEOUT"
	| "UNSUPPORTED_MULTIHASH";

export interface VerificationError {
	code: VerificationErrorCode;
	message: string;
}

export type VerificationResult<T> =
	| { success: true; value: T }
	| { success: false; error: VerificationError };

export function verificationError(
	code: VerificationErrorCode,
	message: string,
): VerificationResult<never> {
	return { success: false, error: { code, message } };
}
