/**
 * Build-time version constants, replaced by tsdown/Vite `define`.
 * Falls back to "dev" when running uncompiled (tests, dev).
 */

declare const __EMDASH_VERSION__: string;
declare const __EMDASH_COMMIT__: string;

export const VERSION: string =
	typeof __EMDASH_VERSION__ !== "undefined" ? __EMDASH_VERSION__ : "dev";

export const COMMIT: string = typeof __EMDASH_COMMIT__ !== "undefined" ? __EMDASH_COMMIT__ : "dev";
