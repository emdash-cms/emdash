/**
 * Type declarations for Cloudflare virtual modules
 *
 * These are only available at runtime on Cloudflare Workers.
 * The types here are minimal - just enough for our usage.
 */

declare module "cloudflare:workers" {
	/**
	 * Environment bindings object
	 * Contains all bindings defined in wrangler.toml (D1, R2, KV, etc.)
	 */
	export const env: Record<string, unknown>;

	/**
	 * Exports object for loopback bindings
	 */
	export const exports: Record<string, unknown>;

	/**
	 * Base class for Worker Entrypoints
	 */
	export class WorkerEntrypoint<TEnv = unknown, TProps = unknown> {
		env: TEnv;
		ctx: ExecutionContext & { props: TProps };
	}
}

declare module "virtual:emdash/room-engine" {
	/** Imports the co-editing room engine, or null when co-editing is off. */
	export const loadRoomEngine:
		| (() => Promise<typeof import("emdash/internal/co-editing/room")>)
		| null;
}

declare module "cloudflare:email" {
	// Email worker types if needed
}
