/**
 * Minimal typing for the Vite compile-time env constants this Worker reads.
 * The full `vite/client` types pull in browser globals the Worker tsconfig does
 * not want, and these are the only members used. Vite statically replaces
 * `import.meta.env.PROD` at build time (true in `vite build`, false in dev and
 * the vitest pool), so it must be written as that literal to be replaced.
 */
interface ImportMetaEnv {
	readonly PROD: boolean;
	readonly DEV: boolean;
}

interface ImportMeta {
	readonly env: ImportMetaEnv;
}
