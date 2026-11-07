// These tests check the TypeScript API without compiling Astro templates.
declare module "*.astro" {
	const component: import("astro/runtime/server/index.js").AstroComponentFactory;
	export default component;
}
