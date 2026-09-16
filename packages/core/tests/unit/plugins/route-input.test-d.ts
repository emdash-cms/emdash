import { expectTypeOf, it } from "vitest";

import type { SandboxedPlugin } from "../../../src/plugin-types.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { PluginRoute } from "../../../src/plugins/types.js";

it("infers native route input from the body mode", () => {
	definePlugin({
		id: "typed-body",
		version: "1.0.0",
		routes: {
			text: {
				body: "text",
				handler: async ({ input }) => {
					expectTypeOf(input).toEqualTypeOf<string>();
					return input.toUpperCase();
				},
			},
			bytes: {
				body: "bytes",
				handler: async ({ input }) => {
					expectTypeOf(input).toEqualTypeOf<Uint8Array<ArrayBuffer>>();
					return input.byteLength;
				},
			},
			json: {
				handler: async ({ input }) => {
					expectTypeOf(input).toEqualTypeOf<unknown>();
					return input;
				},
			},
		},
	});
});

it("infers sandboxed route input from the body mode", () => {
	const plugin = {
		routes: {
			text: {
				body: "text",
				handler: async ({ input }) => {
					expectTypeOf(input).toEqualTypeOf<string>();
					return input.toUpperCase();
				},
			},
			bytes: {
				body: "bytes",
				handler: async ({ input }) => {
					expectTypeOf(input).toEqualTypeOf<Uint8Array<ArrayBuffer>>();
					return input.byteLength;
				},
			},
			json: {
				handler: async ({ input }) => {
					expectTypeOf(input).toEqualTypeOf<unknown>();
					return input;
				},
			},
		},
	} satisfies SandboxedPlugin;
	expectTypeOf(plugin.routes.text.handler)
		.parameter(0)
		.toHaveProperty("input")
		.toEqualTypeOf<string>();
});

it("accepts existing explicitly typed routes and interface extensions", () => {
	interface ExtendedRoute extends PluginRoute {
		label: string;
	}
	const route: ExtendedRoute = { label: "Legacy", handler: async ({ input }) => input };
	definePlugin({ id: "legacy-route", version: "1.0.0", routes: { legacy: route } });
});

it("contextually types configured and bare two-argument handlers", () => {
	const plugin = {
		routes: {
			text: {
				body: "text",
				handler: async (routeCtx, ctx) => {
					expectTypeOf(routeCtx.input).toEqualTypeOf<string>();
					return ctx.plugin.id + routeCtx.input;
				},
			},
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

it("preserves the public resolved-route contract for existing consumers", () => {
	const plugin = definePlugin({
		id: "legacy-consumer",
		version: "1.0.0",
		routes: { hello: { handler: async () => "hello" } },
	});
	const route: PluginRoute = plugin.routes.hello!;
	expectTypeOf(route).toEqualTypeOf<PluginRoute>();
});
