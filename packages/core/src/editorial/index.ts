/**
 * Editorial comment helpers for EmDash's own packages, such as the playground
 * seeder in `@emdash-cms/cloudflare`. Not public API.
 */

export {
	handleEditorialCommentCreate,
	handleEditorialThreadCreate,
} from "../api/handlers/editorial-comments.js";
export type { EditorialActor, EditorialEntryRef } from "../api/handlers/editorial-comments.js";
export { locateQuote } from "@emdash-cms/admin/internal/editorial-anchors";
