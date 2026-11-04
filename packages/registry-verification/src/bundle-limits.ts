/** Maximum accepted gzip payload size. */
export const MAX_BUNDLE_COMPRESSED_BYTES = 384 * 1024;

/** Maximum aggregate size of regular-file contents. */
export const MAX_BUNDLE_SIZE = 256 * 1024;

/** Maximum size of one regular file. */
export const MAX_BUNDLE_FILE_BYTES = 128 * 1024;

/** Maximum number of regular files. */
export const MAX_BUNDLE_FILE_COUNT = 20;

/** Maximum total tar entries, including harmless directory entries. */
export const MAX_BUNDLE_TAR_ENTRY_COUNT = 32;

/**
 * Maximum tar stream size after decompression. This includes USTAR headers,
 * file padding, and the end marker in addition to the regular-file contents.
 */
export const MAX_BUNDLE_DECOMPRESSED_BYTES =
	MAX_BUNDLE_SIZE + MAX_BUNDLE_TAR_ENTRY_COUNT * 512 + MAX_BUNDLE_FILE_COUNT * 511 + 2 * 512;
