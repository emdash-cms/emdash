/**
 * Backend Worker: the whole Astro app runs inside one Durable Object, next to
 * the SQLite database it reads (see do-local-db.ts). The small front Worker in
 * front.ts forwards every request that isn't a static asset here.
 */

import handler from "@astrojs/cloudflare/entrypoints/server";
import { DurableObject, tracing } from "cloudflare:workers";

import { registerStorage } from "./do-local-db.js";

export class SiteDO extends DurableObject<Env> {
	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		registerStorage(ctx.storage);
	}

	override async fetch(request: Request): Promise<Response> {
		const context: ExecutionContext = {
			waitUntil: (promise) => this.ctx.waitUntil(promise),
			passThroughOnException() {},
			props: {},
			exports: this.ctx.exports,
			tracing,
			abort: (reason) => this.ctx.abort(reason),
		};
		return handler.fetch(request, this.env, context);
	}
}

export default {
	fetch: () => new Response("Not found", { status: 404 }),
} satisfies ExportedHandler<Env>;
