import { describe, expect, it } from "vitest";

import { elements } from "../src/builders.js";
import { validateBlocks } from "../src/validation.js";

const actions = (...els: unknown[]) => [{ type: "actions", elements: els }];

describe("media picker dark variant", () => {
	it("builds dark_variant from the darkVariant option", () => {
		expect(elements.mediaPicker("logo", "Logo", { darkVariant: true })).toEqual({
			type: "media_picker",
			action_id: "logo",
			label: "Logo",
			dark_variant: true,
		});
		expect(elements.mediaPicker("logo", "Logo")).not.toHaveProperty("dark_variant");
	});

	it("accepts dark_variant at the top level and in a repeater", () => {
		const logo = elements.mediaPicker("logo", "Logo", { darkVariant: true });
		const slides = elements.repeater("slides", "Slides", [
			elements.mediaPicker("image", "Image", { darkVariant: true }),
		]);
		expect(validateBlocks(actions(logo, slides)).valid).toBe(true);
	});

	it("rejects a non-boolean dark_variant", () => {
		const result = validateBlocks(
			actions({ type: "media_picker", action_id: "logo", label: "Logo", dark_variant: "yes" }),
		);
		expect(result.errors).toEqual([
			expect.objectContaining({ path: "blocks[0].elements[0].dark_variant" }),
		]);
	});

	it("rejects a dark key that another element already uses", () => {
		const result = validateBlocks(
			actions(
				elements.mediaPicker("logo", "Logo", { darkVariant: true }),
				elements.textInput("logo_dark", "Other"),
			),
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]?.path).toBe("blocks[0].elements[0].dark_variant");
	});

	it("rejects a colliding dark key inside a repeater", () => {
		const result = validateBlocks(
			actions(
				elements.repeater("slides", "Slides", [
					elements.mediaPicker("image", "Image", { darkVariant: true }),
					elements.textInput("image_dark", "Alt"),
				]),
			),
		);
		expect(result.valid).toBe(false);
		expect(result.errors[0]?.path).toBe("blocks[0].elements[0].fields[0].dark_variant");
	});

	it("allows a matching key when dark_variant is off", () => {
		const result = validateBlocks(
			actions(elements.mediaPicker("logo", "Logo"), elements.textInput("logo_dark", "Other")),
		);
		expect(result.valid).toBe(true);
	});
});
