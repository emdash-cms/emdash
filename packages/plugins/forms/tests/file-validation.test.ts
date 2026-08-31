import { describe, expect, it } from "vitest";

import { validateSubmissionFiles } from "../src/file-validation.js";

const mb = 1024 * 1024;

function file(filename: string, contentType: string, bytes: number[]) {
	return { filename, contentType, bytes: new Uint8Array(bytes).buffer };
}

describe("validateSubmissionFiles", () => {
	it("accepts PDF, JPEG, PNG, and MP4 signatures", () => {
		expect(() =>
			validateSubmissionFiles({
				pdf: file("brief.pdf", "application/pdf", [0x25, 0x50, 0x44, 0x46, 0x2d]),
				jpg: file("photo.jpg", "image/jpeg", [0xff, 0xd8, 0xff]),
				png: file("plan.png", "image/png", [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
				mp4: file("walkthrough.mp4", "video/mp4", [0, 0, 0, 24, 0x66, 0x74, 0x79, 0x70]),
			}),
		).not.toThrow();
	});

	it("rejects mismatched signatures", () => {
		expect(() =>
			validateSubmissionFiles({
				brief: file("brief.pdf", "application/pdf", [0x3c, 0x68, 0x74, 0x6d, 0x6c]),
			}),
		).toThrow(/signature/i);
	});

	it("enforces five files, 25 MB each, and 125 MB total", () => {
		const tinyPdf = file("brief.pdf", "application/pdf", [0x25, 0x50, 0x44, 0x46, 0x2d]);
		expect(() =>
			validateSubmissionFiles({
				a: tinyPdf,
				b: tinyPdf,
				c: tinyPdf,
				d: tinyPdf,
				e: tinyPdf,
				f: tinyPdf,
			}),
		).toThrow(/five files/i);

		expect(() =>
			validateSubmissionFiles({
				brief: { ...tinyPdf, bytes: new ArrayBuffer(25 * mb + 1) },
			}),
		).toThrow(/25 MB/i);
	});
});
