import { expectTypeOf, it } from "vitest";

import type {
	PluginFormData,
	PluginRouteQuery,
	SandboxedPlugin,
} from "../../../src/plugin-types.js";
import { pluginRoute } from "../../../src/plugin-types.js";
import { definePlugin, definePluginRoute } from "../../../src/plugins/define-plugin.js";
import type { PluginRoute } from "../../../src/plugins/types.js";

it("infers native route input from the declared body mode", () => {
	definePlugin({
		id: "typed-body",
		version: "1.0.0",
		routes: {
			text: definePluginRoute({
				request: { body: "text" },
				handler: async ({ input }) => {
					expectTypeOf(input).toEqualTypeOf<string>();
					return input.toUpperCase();
				},
			}),
			bytes: definePluginRoute({
				request: { body: "bytes" },
				handler: async ({ input }) => {
					expectTypeOf(input).toEqualTypeOf<Uint8Array>();
					return input.byteLength;
				},
			}),
			form: definePluginRoute({
				request: { body: "form-data" },
				handler: async ({ input }) => {
					expectTypeOf(input).toEqualTypeOf<PluginFormData>();
					return input.entries.length;
				},
			}),
			query: definePluginRoute({
				request: { body: "none" },
				handler: async ({ input }) => {
					expectTypeOf(input).toEqualTypeOf<PluginRouteQuery>();
					return input;
				},
			}),
			json: definePluginRoute({
				request: { body: "json" },
				handler: async ({ input }) => {
					expectTypeOf(input).toEqualTypeOf<unknown>();
					return input;
				},
			}),
			legacy: {
				handler: async ({ input }) => {
					expectTypeOf(input).toEqualTypeOf<unknown>();
					return input;
				},
			},
		},
	});
});

it("infers sandboxed route input from the declared body mode", () => {
	const plugin = {
		routes: {
			text: pluginRoute({
				request: { body: "text" },
				handler: async (routeCtx, ctx) => {
					expectTypeOf(routeCtx.input).toEqualTypeOf<string>();
					return ctx.plugin.id + routeCtx.input;
				},
			}),
			bytes: pluginRoute({
				request: { body: "bytes" },
				handler: async (routeCtx) => {
					expectTypeOf(routeCtx.input).toEqualTypeOf<Uint8Array>();
					return routeCtx.input.byteLength;
				},
			}),
			bare: async (routeCtx, ctx) => {
				expectTypeOf(routeCtx.input).toEqualTypeOf<unknown>();
				return ctx.plugin.id;
			},
		},
	} satisfies SandboxedPlugin;

	expectTypeOf(plugin.routes.text.handler)
		.parameter(0)
		.toHaveProperty("input")
		.toEqualTypeOf<string>();
});

it("preserves the extensible resolved route interface", () => {
	interface ExtendedRoute extends PluginRoute {
		label: string;
	}
	const route: ExtendedRoute = { label: "Legacy", handler: async ({ input }) => input };
	definePlugin({ id: "legacy-route", version: "1.0.0", routes: { legacy: route } });
});
