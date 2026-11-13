/**
 * The editor's video block, with the admin editor's rules for its shape and
 * its ProseMirror attributes.
 */

import { isVideoBlock } from "@emdash-cms/admin/internal/video-block";

import type { PortableTextVideoBlock } from "./types.js";

export { videoBlockFields, videoNodeAttrs } from "@emdash-cms/admin/internal/video-block";

/**
 * Whether a block is the editor's own video block. A `video` block with other
 * fields, or values of other types, belongs to a plugin.
 */
export function isPortableTextVideoBlock(block: unknown): block is PortableTextVideoBlock {
	return isVideoBlock(block);
}
