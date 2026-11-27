/**
 * The admin editor's block keys and comment highlights, for other TipTap
 * editors that save Portable Text, such as the visual editing inline editor.
 *
 * Imports only TipTap and ProseMirror: no React, Lingui or admin styles.
 */

export { PortableTextKeys, generateKey } from "../portable-text/keys.js";
export { PORTABLE_TEXT_KEY_ATTR } from "../components/editor/portableTextIdentity.js";
export {
	anchorForSelection,
	createEditorialCommentsExtension,
	getEditorialHighlights,
	locateAnchor,
	anchorForRange,
	setEditorialHighlights,
} from "../components/editor/EditorialCommentsExtension.js";
export type {
	EditorialCommentsBridge,
	EditorialHighlight,
	SelectionAnchorResult,
} from "../components/editor/EditorialCommentsExtension.js";
export { sameAnchor } from "../editorial-anchors.js";
export type { EditorialAnchor } from "../editorial-anchors.js";
