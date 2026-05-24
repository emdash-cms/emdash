/**
 * @emdash-cms/x402 -- x402 Payment Integration for Astro
 *
 * An Astro integration that provides x402 payment enforcement via
 * Astro.locals.x402. Supports bot-only mode using Cloudflare Bot Management.
 *
 * @example
 * ```ts
 * // astro.config.mjs
 * import { x402 } from "@emdash-cms/x402";
 *
 * export default defineConfig({
 *   integrations: [
 *     x402({
 *       payTo: "0xYourWallet",
 *       network: "eip155:8453",
 *       defaultPrice: "$0.01",
 *       botOnly: true,
 *     }),
 *   ],
 * });
 * ```
 *
 * ```astro
 * ---
 * const { x402 } = Astro.locals;
 *
 * const result = await x402.enforce(Astro.request, { price: "$0.05" });
 * if (result instanceof Response) return result;
 *
 * x402.applyHeaders(result, Astro.response);
 * ---
 * <article>Premium content here</article>
 * ```
 */

import type { AstroIntegration } from "astro";

import type { X402Config } from "./types.js";

const VIRTUAL_MODULE_ID = "virtual:x402/config";
const RESOLVED_VIRTUAL_MODULE_ID = "\0" + VIRTUAL_MODULE_ID;

/**
 * Create the x402 Astro integration.
 */
export function x402(config: X402Config): AstroIntegration {
	return {
		name: "@emdash-cms/x402",
		hooks: {
			"astro:config:setup": ({ addMiddleware, updateConfig }) => {
				// Inject the virtual module that provides config to the middleware.
				// The middleware must be excluded from Vite's SSR dependency optimizer
				// because esbuild cannot resolve virtual modules — only Vite plugins can.
				updateConfig({
					vite: {
						plugins: [
							{
								name: "x402-virtual-config",
								resolveId(id: string) {
									if (id === VIRTUAL_MODULE_ID) return RESOLVED_VIRTUAL_MODULE_ID;
								},
								load(id: string) {
									if (id === RESOLVED_VIRTUAL_MODULE_ID) {
										return `export default ${JSON.stringify(config)}`;
									}
								},
							},
						],
						optimizeDeps: {
							exclude: ["@emdash-cms/x402"],
						},
						ssr: {
							optimizeDeps: {
								exclude: ["@emdash-cms/x402"],
							},
						},
					},
				});

				// Register the middleware that puts the enforcer on locals
				addMiddleware({
					entrypoint: "@emdash-cms/x402/middleware",
					order: "pre",
				});
			},
		},
	};
}

// Re-export types for convenience
export type {
	EnforceOptions,
	EnforceResult,
	Network,
	Price,
	X402Config,
	X402Enforcer,
} from "./types.js";
