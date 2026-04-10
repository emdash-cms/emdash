/**
 * Public API route utilities for auth provider routes.
 *
 * This module re-exports the utilities that auth provider route handlers
 * need from core. Auth providers (plugins) import these via `emdash/api/route-utils`.
 */

export { apiError, apiSuccess, handleError } from "./error.js";
export { parseBody, parseQuery, isParseError } from "./parse.js";
export type { ParseResult } from "./parse.js";
export { finalizeSetup } from "./setup-complete.js";
export { OptionsRepository } from "../database/repositories/options.js";
export { getAuthProviderStorage } from "./auth-storage.js";
