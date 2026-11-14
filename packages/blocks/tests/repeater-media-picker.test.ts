import { describe, expect, it } from "vitest";

import { elements } from "../src/builders.js";
import { validateBlocks } from "../src/validation.js";

describe("media picker repeater fields", () => {
	it("accepts a media picker alongside text through the public builder", () => {
		const slides = elements.repeater("slides", "Slides", [
			elements.mediaPicker("image", "Image", { mimeTypeFilter: "image/" }),
			elements.textInput("caption", "Caption"),
		]);

		expect(validateBlocks([{ type: "actions", elements: [slides] }])).toEqual({
			valid: true,
			errors: [],
		});
	});

	it.each([
		["mime_type_filter", "video/"],
		["initial_value", 42],
		["placeholder", false],
	])("validates a nested media picker's %s", (property, value) => {
		const result = validateBlocks([
			{
				type: "actions",
				elements: [
					{
						type: "repeater",
						action_id: "slides",
						label: "Slides",
						fields: [
							{
								type: "media_picker",
								action_id: "image",
								label: "Image",
								[property]: value,
							},
						],
					},
				],
			},
		]);

		expect(result.valid).toBe(false);
		expect(result.errors).toEqual([
			expect.objectContaining({ path: `blocks[0].elements[0].fields[0].${property}` }),
		]);
	});
});
