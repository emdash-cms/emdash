// Separate barrel so importing PortableText/block components from
// `emdash/ui` doesn't pull Comments/CommentForm's CSS into the page's
// shared chunk graph.
export { default as Comments } from "./Comments.astro";
export { default as CommentForm } from "./CommentForm.astro";
