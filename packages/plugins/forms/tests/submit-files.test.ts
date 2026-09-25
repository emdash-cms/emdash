import { describe, expect, it, vi } from "vitest";

import { submitHandler } from "../src/handlers/submit.js";
import { MAX_SUBMISSION_FILE_BYTES, submitSchema } from "../src/schemas.js";
import type { FormDefinition } from "../src/types.js";

function form(): FormDefinition {
	return {
		name: "Upload",
		slug: "upload",
		status: "active",
		pages: [
			{
				fields: [
					{
						id: "f1",
						name: "attachment",
						label: "Attachment",
						type: "file",
						required: false,
						width: "full",
						validation: { maxFileSize: 1000 },
					},
					{ id: "f2", name: "extra", label: "Extra", type: "file", required: false, width: "full" },
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

/** Parses the body as the route does, so the handler sees the schema's output. */
function context(body: unknown, media?: Record<string, unknown>) {
	const upload = vi.fn(async (_name: string, _type: string, bytes: ArrayBuffer) => ({
		mediaId: "m1",
		storageKey: "k1",
		url: "/k1",
		size: bytes.byteLength,
	}));
	const ctx = {
		input: submitSchema.parse(body),
		storage: {
			forms: {
				get: async (id: string) => (id === "upload" ? form() : null),
				put: async () => {},
				query: async () => ({ items: [] }),
			},
			submissions: { put: async () => {}, count: async () => 1 },
		},
		kv: { get: async () => null },
		log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		media: media ?? { upload },
		requestMeta: { ip: "203.0.113.1", userAgent: "test", referer: null, headers: {} },
	};
	return { ctx, upload };
}

const submission = (bytes: unknown) => ({
	formId: "upload",
	data: {},
	files: { attachment: { filename: "a.png", contentType: "image/png", bytes } },
});

describe("file uploads on public submissions", () => {
	it("rejects a JSON byte array larger than the field's maxFileSize", async () => {
		const { ctx, upload } = context(submission(Array.from<number>({ length: 2000 }).fill(65)));

		await expect(submitHandler(ctx as never)).rejects.toMatchObject({ status: 400 });
		expect(upload).not.toHaveBeenCalled();
	});

	it("uploads the posted bytes when they fit", async () => {
		const { ctx, upload } = context(submission([137, 80, 78, 71]));

		await submitHandler(ctx as never);

		expect(upload).toHaveBeenCalledOnce();
		const sent = upload.mock.calls[0]![2];
		expect(sent).toBeInstanceOf(ArrayBuffer);
		expect(new Uint8Array(sent)).toEqual(new Uint8Array([137, 80, 78, 71]));
	});

	it("decodes base64 file contents and applies maxFileSize to the decoded size", async () => {
		const { ctx, upload } = context(submission("iVBORw=="));
		await submitHandler(ctx as never);
		expect(new Uint8Array(upload.mock.calls[0]![2])).toEqual(new Uint8Array([137, 80, 78, 71]));

		const tooLarge = context(submission(btoa("A".repeat(2000))));
		await expect(submitHandler(tooLarge.ctx as never)).rejects.toMatchObject({ status: 400 });
		expect(tooLarge.upload).not.toHaveBeenCalled();
	});

	it("accepts base64 contents of a multi-megabyte file", () => {
		const bytes = new Uint8Array(5 * 1024 * 1024).fill(0xab);
		const parsed = submitSchema.parse(submission(Buffer.from(bytes).toString("base64")));
		expect(Buffer.from(parsed.files!.attachment!.bytes).equals(bytes)).toBe(true);
	});

	it("rejects an empty file", () => {
		expect(submitSchema.safeParse(submission("")).success).toBe(false);
		expect(submitSchema.safeParse(submission([])).success).toBe(false);
	});

	it("rejects file contents that are not valid base64", () => {
		expect(submitSchema.safeParse(submission("not base64!")).success).toBe(false);
		expect(submitSchema.safeParse(submission("abc")).success).toBe(false);
	});

	it("rejects file bytes that are not an array of octets", () => {
		expect(submitSchema.safeParse(submission({ length: 1 })).success).toBe(false);
		expect(submitSchema.safeParse(submission([256])).success).toBe(false);
	});

	it("rejects file bytes above the 10 MB ceiling", () => {
		const bytes = Array.from<number>({ length: MAX_SUBMISSION_FILE_BYTES + 1 }).fill(0);
		expect(submitSchema.safeParse(submission(bytes)).success).toBe(false);
	});

	it("deletes files already uploaded when a later file in the submission is rejected", async () => {
		const upload = vi
			.fn()
			.mockResolvedValueOnce({ mediaId: "m1", storageKey: "k1.png", url: "/k1.png" })
			.mockRejectedValueOnce(Object.assign(new Error("File type not allowed"), { status: 415 }));
		const remove = vi.fn(async () => true);
		const { ctx } = context(
			{
				formId: "upload",
				data: {},
				files: {
					attachment: { filename: "a.png", contentType: "image/png", bytes: "iVBORw==" },
					extra: { filename: "b.html", contentType: "text/html", bytes: "PGgxPg==" },
				},
			},
			{ upload, delete: remove },
		);

		await expect(submitHandler(ctx as never)).rejects.toMatchObject({ status: 415 });
		expect(remove).toHaveBeenCalledWith("m1");
	});
});
