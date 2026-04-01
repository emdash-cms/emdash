/**
 * x402 Astro Middleware
 *
 * Injected by the x402 integration. Creates the enforcer and
 * places it on Astro.locals.x402 for use in page frontmatter.
 *
 * The config is passed via the virtual module resolved by the integration.
 */

import { defineMiddleware } from "astro:middleware";
// The integration injects config via a virtual module.
// @ts-ignore -- virtual module, resolved at build time
import x402Config from "virtual:x402/config";

import { createEnforcer } from "./enforcer.js";
import type { X402Config } from "./types.js";

// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- virtual module import has no type info
const config: X402Config = x402Config as X402Config;
const enforcer = createEnforcer(config);

export const onRequest = defineMiddleware(async (context, next) => {
	context.locals.x402 = enforcer;
	return next();
});
