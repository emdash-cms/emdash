import { describe, expect, it, vi } from "vitest";

import { serializeSubmission } from "../src/client/index.js";
import { submitHandler } from "../src/handlers/submit.js";
import { submitSchema } from "../src/schemas.js";
import type { FormDefinition } from "../src/types.js";

function form(): FormDefinition {
	return {
		name: "Apply",
		slug: "apply",
		status: "active",
		pages: [
			{
				fields: [
					{ id: "f1", name: "name", label: "Name", type: "text", required: true, width: "full" },
					{ id: "f2", name: "cv", label: "CV", type: "file", required: true, width: "full" },
					{
						id: "f3",
						name: "portfolio",
						label: "Portfolio",
						type: "file",
						required: false,
						width: "full",
						condition: { field: "name", op: "eq", value: "Grace" },
					},
				],
			},
		],
		submissionCount: 0,
		lastSubmissionAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		settings: {
			spamProtection: "none",
			notifyEmails: [],
			digestEnabled: false,
			digestHour: 9,
			retentionDays: 0,
			submitLabel: "Send",
			confirmationMessage: "Thanks",
		},
	} as unknown as FormDefinition;
}

async function applicationBody(): Promise<unknown> {
	const formData = new FormData();
	formData.append("formId", "apply");
	formData.append("name", "Ada");
	formData.append(
		"cv",
		new File([new Uint8Array([37, 80, 68, 70])], "cv.pdf", { type: "application/pdf" }),
	);
	return JSON.parse(await serializeSubmission(formData));
}

function context(input: unknown, media: unknown) {
	const stored: unknown[] = [];
	const ctx = {
		input: submitSchema.parse(input),
		storage: {
			forms: {
				get: async (id: string) => (id === "apply" ? form() : null),
				put: async () => {},
				query: async () => ({ items: [] }),
			},
			submissions: {
				put: async (_id: string, value: unknown) => void stored.push(value),
				count: async () => 1,
			},
		},
		kv: { get: async () => null },
		log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		media,
		requestMeta: { ip: "203.0.113.1", userAgent: "test", referer: null, headers: {} },
	};
	return { ctx, stored };
}

describe("submitting a form with a file field from the bundled client", () => {
	it("is accepted and uploads the chosen file", async () => {
		const uploaded: Uint8Array[] = [];
		const upload = vi.fn(async (_name: string, _type: string, bytes: ArrayBuffer) => {
			uploaded.push(new Uint8Array(bytes));
			return { mediaId: "m1", storageKey: "k1.pdf", url: "/k1.pdf" };
		});
		const { ctx, stored } = context(await applicationBody(), { upload });

		const result = await submitHandler(ctx as never);

		expect(result).toMatchObject({ success: true });
		expect(upload).toHaveBeenCalledWith("cv.pdf", "application/pdf", expect.any(ArrayBuffer));
		expect(uploaded).toEqual([new Uint8Array([37, 80, 68, 70])]);
		expect(stored).toMatchObject([
			{
				data: { name: "Ada" },
				files: [{ fieldName: "cv", filename: "cv.pdf", size: 4, mediaId: "m1" }],
			},
		]);
	});

	it("fails instead of saving without the file when uploads are unavailable", async () => {
		const { ctx, stored } = context(await applicationBody(), undefined);

		await expect(submitHandler(ctx as never)).rejects.toMatchObject({ status: 500 });
		expect(stored).toEqual([]);
	});

	it("does not upload a file sent for a field its condition hides", async () => {
		const body = (await applicationBody()) as { files: Record<string, unknown> };
		body.files.portfolio = { filename: "page.pdf", contentType: "application/pdf", bytes: "AQID" };
		const upload = vi.fn(async () => ({ mediaId: "m1", storageKey: "k1.pdf", url: "/k1.pdf" }));
		const { ctx, stored } = context(body, { upload });

		await submitHandler(ctx as never);

		expect(upload).toHaveBeenCalledTimes(1);
		expect(upload).toHaveBeenCalledWith("cv.pdf", "application/pdf", expect.any(ArrayBuffer));
		expect(stored).toMatchObject([{ files: [{ fieldName: "cv" }] }]);
	});
});
