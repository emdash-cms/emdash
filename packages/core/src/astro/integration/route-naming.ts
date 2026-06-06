/**
 * Compiled route artifact naming -- single source of truth.
 *
 * rolldown reserves `[name]`, `[hash]`, `[ext]` (and more) as output-filename
 * placeholders, so compiled route files cannot keep Astro's literal
 * `[param]` dynamic-segment filenames -- a path containing `[name]` would be
 * substituted by the bundler. This function defines the safe artifact form.
 *
 * It is imported by BOTH the build (`tsdown.config.ts` `entryFileNames`) and
 * the route injector (`resolveRoute`, which resolves `emdash/routes/*`).
 * They must stay in lockstep: change the scheme here and both follow.
 *
 * `[` and `]` -> `_` (e.g. `[collection]` -> `_collection_`,
 * `[...path]` -> `_...path_`). The Astro route URL pattern is set explicitly
 * at injection time, so the artifact filename never affects routing.
 */
export function routeArtifactName(srcRelativePathNoExt: string): string {
	return srcRelativePathNoExt.replaceAll("[", "_").replaceAll("]", "_");
}
