import { defineLexiconConfig } from "@atcute/lex-cli";

/**
 * Codegen config for the EmDash plugin registry lexicons.
 *
 * Source lexicons live at the repo root under `lexicons/com/emdashcms/experimental/`
 * (currently authored on the RFC branch). Generated TypeScript output lands in
 * `src/generated/` and is checked into git so consumers don't need the codegen toolchain.
 *
 * The single external reference is `com.atproto.label.defs#label`, resolved via
 * `@atcute/atproto` which exposes the standard atproto namespace.
 */
export default defineLexiconConfig({
	files: ["../../lexicons/com/emdashcms/experimental/**/*.json"],
	outdir: "src/generated/",
	imports: ["@atcute/atproto"],
});
