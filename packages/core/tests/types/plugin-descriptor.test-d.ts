import { describe, expectTypeOf, it } from "vitest";

import type {
	EmDashConfig,
	PluginDescriptor,
	SandboxedPluginDescriptor,
} from "../../src/astro/integration/runtime.js";

// The options shape `emdash plugin init --native` scaffolds, and the one
// `@emdash-cms/plugin-forms` and `@emdash-cms/plugin-embeds` declare: an
// interface, which has no implicit index signature.
interface InterfaceOptions {
	enabled?: boolean;
}

type AliasOptions = {
	enabled?: boolean;
};

declare function interfacePlugin(options?: InterfaceOptions): PluginDescriptor<InterfaceOptions>;
declare function aliasPlugin(options?: AliasOptions): PluginDescriptor<AliasOptions>;
declare function optionlessPlugin(): PluginDescriptor;

describe("PluginDescriptor options", () => {
	it("registers plugins whose options are declared as an interface", () => {
		const config: EmDashConfig = {
			plugins: [interfacePlugin(), aliasPlugin(), optionlessPlugin()],
		};
		expectTypeOf(config.plugins).not.toBeNever();
	});

	it("registers interface-typed sandboxed plugin descriptors", () => {
		const descriptor: SandboxedPluginDescriptor<InterfaceOptions> = {
			id: "sandboxed-interface",
			version: "1.0.0",
			entrypoint: "@example/sandboxed-interface",
			options: { enabled: true },
		};
		const config: EmDashConfig = { sandboxed: [descriptor] };
		expectTypeOf(config.sandboxed).not.toBeNever();
	});

	it("passes registered descriptors to code typed with the default parameter", () => {
		// Core forwards `config.plugins` to helpers typed `PluginDescriptor[]`.
		const descriptors: PluginDescriptor[] = [interfacePlugin()];
		expectTypeOf(descriptors).toEqualTypeOf<PluginDescriptor[]>();
	});

	it("rejects options that are not an object where the descriptor is declared", () => {
		// @ts-expect-error -- plugin options must be an object
		type StringOptionsDescriptor = PluginDescriptor<string>;
		// @ts-expect-error -- plugin options must be an object
		type StringOptionsSandboxed = SandboxedPluginDescriptor<string>;
		expectTypeOf<StringOptionsDescriptor>().not.toBeNever();
		expectTypeOf<StringOptionsSandboxed>().not.toBeNever();
	});
});
