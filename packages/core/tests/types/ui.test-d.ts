import { Block as BlockComponent } from "emdash/ui";
import type {
	ArbitraryTypedObject,
	Block,
	PortableTextBlock,
	PortableTextListItemBlock,
	PortableTextMarkDefinition,
	PortableTextProps,
	PortableTextSpan,
	SomePortableTextComponents,
	TypedObject,
} from "emdash/ui";
import { describe, expectTypeOf, it } from "vitest";

describe("Portable Text public types", () => {
	it("preserves the renderer props and component map", () => {
		type CustomNode = { _type: "custom"; title: string };
		expectTypeOf<PortableTextProps<CustomNode>["value"]>().toEqualTypeOf<
			CustomNode | CustomNode[]
		>();
		expectTypeOf<PortableTextProps["components"]>().toEqualTypeOf<
			SomePortableTextComponents | undefined
		>();
		expectTypeOf<SomePortableTextComponents>().not.toBeAny();
	});

	it("preserves typed nodes, blocks, spans, and marks", () => {
		expectTypeOf<TypedObject["_type"]>().toEqualTypeOf<string>();
		expectTypeOf<ArbitraryTypedObject["_type"]>().toEqualTypeOf<string>();
		expectTypeOf<PortableTextBlock["_type"]>().toEqualTypeOf<string>();
		expectTypeOf<PortableTextSpan["text"]>().toEqualTypeOf<string>();
		expectTypeOf<PortableTextMarkDefinition["_key"]>().toEqualTypeOf<string>();
		expectTypeOf<PortableTextListItemBlock["listItem"]>().toEqualTypeOf<string>();
		expectTypeOf<Block>().toExtend<PortableTextBlock>();
		expectTypeOf<Block["style"]>().toEqualTypeOf<string>();
		expectTypeOf(BlockComponent).toBeFunction();

		// @ts-expect-error -- a number is not a Portable Text block
		const invalidBlock: PortableTextBlock = 123;
		void invalidBlock;
	});
});
