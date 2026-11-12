/**
 * The admin editor's ProseMirror schema and its Portable Text converter.
 *
 * Server-safe: the editor and server code share it, so both read and write
 * rich text the same way.
 */

export { portableTextExtensions, portableTextSchema } from "../portable-text/schema.js";
export { PortableTextFilledDefaults } from "../portable-text/schema.js";
export { portableTextToProsemirror, prosemirrorToPortableText } from "../portable-text/convert.js";
export type { PortableTextBlock } from "../portable-text/convert.js";
export { findUnsupportedPortableTextMarks } from "../lib/portable-text-marks.js";
