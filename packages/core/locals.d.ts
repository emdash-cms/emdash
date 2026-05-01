/**
 * EmDash Astro type declarations
 *
 * Augments App.Locals with EmDash types.
 * Referenced via triple-slash directive in the generated emdash-env.d.ts.
 */

import type { User } from "@emdash-cms/auth";

import type { EmDashHandlers } from "./dist/types.d.mts";

declare global {
	namespace App {
		interface Locals {
			/**
			 * EmDash API handlers - available on /_emdash/* routes
			 */
			emdash: EmDashHandlers;

			/**
			 * Authenticated user - set by auth middleware when a valid session exists
			 */
			user?: User;

			/**
			 * Per-session Durable Object database for playground mode.
			 *
			 * Set by the playground middleware (@emdash-cms/cloudflare). Read by
			 * the runtime middleware and request-context middleware to set the
			 * database in ALS for the current request.
			 *
			 * This exists because Vite SSR loads two copies of request-context.ts
			 * (dist for integration middleware, source for the loader). locals
			 * bridges the DB across that module boundary.
			 */
			__playgroundDb?: unknown;
		}
	}
}

export {};
