import { describe, expect, it } from "vitest";

import { file } from "../../../src/fields/file.js";
import { image } from "../../../src/fields/image.js";

describe("file builder", () => {
	it("copies allowedTypes into validation.allowedMimeTypes", () => {
		const def = file({ allowedTypes: ["application/pdf", "application/zip"] });
		expect(def.validation?.allowedMimeTypes).toEqual(["application/pdf", "application/zip"]);
	});

	it("does not write ui.allowedTypes (legacy inert location)", () => {
		const def = file({ allowedTypes: ["application/pdf"] });
		expect(def.ui?.allowedTypes).toBeUndefined();
	});

	it("omits allowedMimeTypes when allowedTypes is not provided", () => {
		const def = file({});
		expect(def.validation?.allowedMimeTypes).toBeUndefined();
	});
});

describe("image builder", () => {
	it("copies allowedTypes into validation.allowedMimeTypes", () => {
		const def = image({ allowedTypes: ["image/png", "image/jpeg"] });
		expect(def.validation?.allowedMimeTypes).toEqual(["image/png", "image/jpeg"]);
	});

	it("omits allowedMimeTypes when allowedTypes is not provided", () => {
		const def = image();
		expect(def.validation?.allowedMimeTypes).toBeUndefined();
	});
});

describe("image field schema", () => {
	it("keeps the focal point on the value", () => {
		const value = {
			id: "img123",
			provider: "local",
			focalX: 0.25,
			focalY: 0.75,
		};
		expect(image().schema.parse(value)).toEqual(value);
	});

	it("keeps the focal point on a dark variant", () => {
		const value = {
			id: "img123",
			provider: "local",
			darkVariant: { id: "img456", provider: "local", focalX: 0.5, focalY: 0.1 },
		};
		expect(image().schema.parse(value)).toEqual(value);
	});
});
