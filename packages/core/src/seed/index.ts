/**
 * Seed API - public exports
 *
 * Provides the seeding API for bootstrapping EmDash sites.
 */

export { applySeed } from "./apply.js";
export { defaultSeed } from "./default.js";
export { loadSeed, loadSeedMediaBasePath, loadUserSeed } from "./load.js";
export { validateSeed } from "./validate.js";

export type {
	SeedFile,
	SeedCollection,
	SeedField,
	SeedTaxonomy,
	SeedTaxonomyTerm,
	SeedMenu,
	SeedMenuItem,
	SeedRedirect,
	SeedWidgetArea,
	SeedWidget,
	SeedSection,
	SeedContentEntry,
	SeedApplyOptions,
	SeedApplyResult,
	ValidationResult,
} from "./types.js";
