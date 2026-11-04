import { expect, it } from "vitest";

import {
	defineBlockComponents,
	resolveBlockRenderer,
	type BlockComponent,
} from "../../../src/components/blocks.js";

type FixtureBlock =
	| { _type: "hero"; _version: 1; _key: string; heading: string }
	| { _type: "hero"; _version: 2; _key: string; title: string }
	| { _type: "quote"; _version: 1; _key: string; text: string };

const component: BlockComponent<FixtureBlock> = () => null;

it("selects mapped components before missing-renderer behavior", () => {
	const components = defineBlockComponents<FixtureBlock>({
		hero: component,
		quote: component,
	});
	const block: FixtureBlock = {
		_type: "hero",
		_version: 1,
		_key: "hero-1",
		heading: "Hello",
	};

	expect(resolveBlockRenderer(block, components, undefined, true)).toEqual({
		kind: "component",
		component,
	});
});

it("uses a visible diagnostic only in development", () => {
	const block: FixtureBlock = {
		_type: "quote",
		_version: 1,
		_key: "quote-1",
		text: "Hello",
	};

	expect(resolveBlockRenderer(block, {}, component, true)).toEqual({ kind: "diagnostic" });
	expect(resolveBlockRenderer(block, {}, component, false)).toEqual({
		kind: "fallback",
		component,
	});
	expect(resolveBlockRenderer(block, {}, undefined, false)).toEqual({ kind: "none" });
});
