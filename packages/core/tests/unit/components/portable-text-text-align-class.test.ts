/**
 * Frontend rendering for #1201: text alignment from the rich-text editor
 * must surface as a CSS class on the rendered paragraph/heading so the
 * public site reflects what the editor showed.
 *
 * Convention: WordPress-style `has-text-align-{value}` so existing themes
 * (especially WordPress imports) get matching styles for free.
 *
 * `left` is the document default and intentionally omits the class — keeps
 * older Portable Text bytewise unchanged when no alignment was ever set,
 * matching the converter's own omit-on-default rule from the bot fix.
 */
import { describe, expect, it } from "vitest";

import { textAlignClassName } from "../../../src/components/portable-text-text-align.js";

describe("textAlignClassName", () => {
	it("returns has-text-align-center for center alignment", () => {
		expect(textAlignClassName("center")).toBe("has-text-align-center");
	});

	it("returns has-text-align-right for right alignment", () => {
		expect(textAlignClassName("right")).toBe("has-text-align-right");
	});

	it("returns has-text-align-justify for justify alignment", () => {
		expect(textAlignClassName("justify")).toBe("has-text-align-justify");
	});

	it("returns undefined for left alignment (default; no class needed)", () => {
		expect(textAlignClassName("left")).toBeUndefined();
	});

	it("returns undefined when textAlign is missing", () => {
		expect(textAlignClassName(undefined)).toBeUndefined();
	});

	it("returns undefined for unknown values to avoid emitting attacker-controlled classes", () => {
		// Defence against PT blocks edited by hand or imported from a hostile source.
		// Only the four documented values are class-bearing.
		expect(textAlignClassName("inherit" as never)).toBeUndefined();
		expect(textAlignClassName("" as never)).toBeUndefined();
		expect(textAlignClassName("center; color:red" as never)).toBeUndefined();
	});
});
