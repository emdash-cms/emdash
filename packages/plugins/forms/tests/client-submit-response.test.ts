import { describe, expect, it } from "vitest";

import { parseSubmitResponse, serializeSubmission } from "../src/client/index.js";
import { submitSchema } from "../src/schemas.js";

describe("parseSubmitResponse", () => {
	it("unwraps successful plugin API responses from the standard API envelope", () => {
		expect(
			parseSubmitResponse({
				data: {
					success: true,
					message: "Thanks",
					redirect: "/thanks",
				},
			}),
		).toEqual({ success: true, message: "Thanks", redirect: "/thanks" });
	});

	it("keeps legacy top-level submit responses working", () => {
		expect(parseSubmitResponse({ success: true, message: "Thanks" })).toEqual({
			success: true,
			message: "Thanks",
		});
	});

	it("unwraps validation errors returned in the standard API envelope", () => {
		expect(
			parseSubmitResponse({
				data: {
					errors: [{ field: "email", message: "Email is required" }],
				},
			}),
		).toEqual({ errors: [{ field: "email", message: "Email is required" }] });
	});

	it("does not recursively unwrap nested envelopes", () => {
		expect(parseSubmitResponse({ data: { data: { success: true, message: "Nested" } } })).toEqual({
			data: { success: true, message: "Nested" },
		});
	});
});

describe("serializeSubmission", () => {
	it("sends a chosen file as bytes alongside the text fields", async () => {
		const formData = new FormData();
		formData.append("formId", "contact");
		formData.append("name", "Ada");
		formData.append(
			"attachment",
			new File([new Uint8Array([1, 2, 3])], "a.pdf", { type: "application/pdf" }),
		);

		expect(JSON.parse(await serializeSubmission(formData))).toEqual({
			formId: "contact",
			data: { name: "Ada" },
			files: {
				attachment: { filename: "a.pdf", contentType: "application/pdf", bytes: "AQID" },
			},
		});
	});

	it("round-trips a multi-megabyte file to the same bytes on the server", async () => {
		const bytes = Uint8Array.from({ length: 5 * 1024 * 1024 }, (_, i) => (i * 7) % 256);
		const formData = new FormData();
		formData.append("formId", "contact");
		formData.append("attachment", new File([bytes], "a.bin"));

		const parsed = submitSchema.parse(JSON.parse(await serializeSubmission(formData)));
		expect(Buffer.from(parsed.files!.attachment!.bytes).equals(bytes)).toBe(true);
	});

	it("leaves out a file input nobody filled", async () => {
		const formData = new FormData();
		formData.append("formId", "contact");
		formData.append("attachment", new File([], ""));

		expect(JSON.parse(await serializeSubmission(formData))).toEqual({
			formId: "contact",
			data: {},
		});
	});
});
