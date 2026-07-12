// Vite's `?raw` import suffix (used by production-boundary.test.ts to load
// a source file's text without any filesystem access at test time) has no
// ambient type in this project's `@cloudflare/workers-types`-based tsconfig.
declare module "*?raw" {
	const content: string;
	export default content;
}
