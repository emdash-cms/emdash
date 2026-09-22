/**
 * EmDash comment components
 *
 * Kept out of the main `emdash/ui` barrel so their styles are only loaded on
 * pages that actually render comments. Importing from `emdash/ui` pulls the
 * whole barrel into Astro's CSS module graph, which put comment CSS on every
 * page that used e.g. `PortableText` (#2039).
 *
 * ```astro
 * ---
 * import { Comments, CommentForm } from "emdash/ui/comments";
 * ---
 * <Comments collection="posts" contentId={post.data.id} threaded />
 * <CommentForm collection="posts" contentId={post.data.id} />
 * ```
 */

export { default as Comments } from "./components/Comments.astro";
export { default as CommentForm } from "./components/CommentForm.astro";
