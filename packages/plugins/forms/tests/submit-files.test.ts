import { describe, expect, it, vi } from "vitest";

import { deleteSubmissionFiles } from "../src/cleanup.js";
import { submitHandler } from "../src/handlers/submit.js";
import { createPlugin } from "../src/index.js";
import type { FormDefinition } from "../src/types.js";

const form: FormDefinition = {
	name: "Estimate",
	slug: "project-estimate",
	pages: [
		{
			fields: [
				{
					id: "brief",
					name: "brief",
					label: "Project brief",
					type: "file",
					required: true,
					width: "full",
					validation: { accept: ".pdf", maxFileSize: 25 * 1024 * 1024 },
				},
			],
		},
	],
	settings: {
		confirmationMessage: "Thanks",
		notifyEmails: [],
		digestEnabled: false,
		digestHour: 8,
		retentionDays: 365,
		spamProtection: "none",
		submitLabel: "Send",
	},
	status: "active",
	submissionCount: 0,
	lastSubmissionAt: null,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

function context(bytes = [0x25, 0x50, 0x44, 0x46, 0x2d]) {
	const upload = vi.fn(async () => ({
		mediaId: "media-1",
		storageKey: "private/media-1.pdf",
		url: "/_emdash/api/media/private/media-1.pdf",
	}));
	const putSubmission = vi.fn();
	return {
		ctx: {
			input: {
				formId: "project-estimate",
				data: {},
				files: {
					brief: {
						filename: "brief.pdf",
						contentType: "application/pdf",
						bytes: new Uint8Array(bytes).buffer,
					},
				},
			},
			storage: {
				forms: {
					get: vi.fn(async () => form),
					put: vi.fn(),
					query: vi.fn(),
				},
				submissions: {
					put: putSubmission,
					count: vi.fn(async () => 1),
				},
			},
			media: { upload, delete: vi.fn() },
			requestMeta: { ip: null, userAgent: null, referer: null },
			log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		},
		upload,
		putSubmission,
	};
}

describe("private form attachments", () => {
	it("grants editors submission access without granting form or plugin configuration", () => {
		const routes = createPlugin().routes;
		expect(routes["submissions/list"]?.permission).toBe("plugins:read");
		expect(routes["submissions/get"]?.permission).toBe("plugins:read");
		expect(routes["submissions/delete"]?.permission).toBe("plugins:read");
		expect(routes["forms/update"]?.permission).toBeUndefined();
		expect(routes["settings/turnstile-status"]?.permission).toBeUndefined();
	});

	it("uploads validated files as private and stores the authenticated download URL", async () => {
		const { ctx, upload, putSubmission } = context();
		await expect(submitHandler(ctx as never)).resolves.toMatchObject({ success: true });
		expect(upload).toHaveBeenCalledWith("brief.pdf", "application/pdf", expect.any(ArrayBuffer), {
			visibility: "private",
		});
		expect(putSubmission).toHaveBeenCalledWith(
			expect.any(String),
			expect.objectContaining({
				files: [
					expect.objectContaining({
						mediaId: "media-1",
						downloadUrl: "/_emdash/api/media/private/media-1.pdf",
					}),
				],
			}),
		);
	});

	it("rejects spoofed files before media storage is called", async () => {
		const { ctx, upload } = context([0x3c, 0x68, 0x74, 0x6d, 0x6c]);
		await expect(submitHandler(ctx as never)).rejects.toThrow(/signature/i);
		expect(upload).not.toHaveBeenCalled();
	});

	it("retains submission records when attachment cleanup fails", async () => {
		const error = vi.fn();
		const result = await deleteSubmissionFiles(
			{
				media: { delete: vi.fn(async () => Promise.reject(new Error("R2 unavailable"))) },
				log: { error },
			} as never,
			[
				{
					fieldName: "brief",
					filename: "brief.pdf",
					contentType: "application/pdf",
					size: 5,
					mediaId: "media-1",
					downloadUrl: "/private/media-1",
				},
			],
		);
		expect(result).toBe(false);
		expect(error).toHaveBeenCalled();
	});
});
