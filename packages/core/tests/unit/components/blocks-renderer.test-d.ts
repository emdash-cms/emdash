import { expectTypeOf, it } from "vitest";

import { defineBlockComponents, type BlockComponentProps } from "../../../src/components/blocks.js";

type PageBlock =
	| { _type: "hero"; _version: 1; _key: string; heading: string }
	| { _type: "hero"; _version: 2; _key: string; title: string }
	| { _type: "quote"; _version: 1; _key: string; text: string };

it("requires every block type and preserves retained-version unions", () => {
	defineBlockComponents<PageBlock>({
		hero: (props) => {
			expectTypeOf(props).toEqualTypeOf<
				BlockComponentProps<Extract<PageBlock, { _type: "hero" }>>
			>();
			if (props.value._version === 1) return props.value.heading;
			return props.value.title;
		},
		quote: (props) => props.value.text,
	});

	// @ts-expect-error -- every stored block type needs a component
	defineBlockComponents<PageBlock>({ hero: () => null });

	defineBlockComponents<PageBlock>({
		hero: () => null,
		quote: () => null,
		// @ts-expect-error -- components are keyed by the generated _type union
		unknown: () => null,
	});
});
