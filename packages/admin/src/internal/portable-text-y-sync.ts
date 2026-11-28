/**
 * The editor's Yjs binding fixes, for EmDash's own code and tests that sync an
 * editor built from `portableTextExtensions()` through Yjs.
 *
 * Loads Yjs and y-tiptap, so it stays out of `@emdash-cms/admin/internal/portable-text`,
 * which sites load on the server.
 */

export { PortableTextYSync } from "../portable-text/y-sync.js";
