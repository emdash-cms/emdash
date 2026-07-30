import type { APIContext } from "astro";
import { beforeEach, describe, expect, it, vi } from "vitest";

const configuredImageServiceSupportsHeic = vi.hoisted(() => vi.fn(async () => false));

vi.mock("../../../src/astro/image-service.js", () => ({ configuredImageServiceSupportsHeic }));

import { POST as directUpload } from "../../../src/astro/routes/api/media.js";
import { POST as signedUpload } from "../../../src/astro/routes/api/media/upload-url.js";

function context(request: Request, emdash: Record<string, unknown>): APIContext {
	return {
		request,
		url: new URL(request.url),
		params: {},
		locals: {
			emdash,
			user: { id: "user-1", email: "t@example.com", name: "T", role: 50 as const },
		},
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal route context
	} as unknown as APIContext;
}

describe("HEIC upload capability gate", () => {
	beforeEach(() => {
		configuredImageServiceSupportsHeic.mockResolvedValue(false);
	});

	it("rejects direct uploads before writing to storage", async () => {
		const upload = vi.fn();
		const form = new FormData();
		form.append(
			"file",
			new File([new Uint8Array([1, 2, 3])], "photo.heic", { type: "image/heic" }),
		);
		const request = new Request("https://site.example.com/_emdash/api/media", {
			method: "POST",
			body: form,
		});

		const response = await directUpload(
			context(request, {
				db: {},
				config: {},
				handleMediaCreate: vi.fn(),
				storage: { upload },
			}),
		);

		expect(response.status).toBe(415);
		expect(upload).not.toHaveBeenCalled();
	});

	it("rejects signed uploads before creating a pending object", async () => {
		const getSignedUploadUrl = vi.fn();
		const request = new Request("https://site.example.com/_emdash/api/media/upload-url", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				filename: "photo.heic",
				contentType: "image/heic",
				size: 1024,
			}),
		});

		const response = await signedUpload(
			context(request, {
				db: {},
				config: {},
				storage: { getSignedUploadUrl },
			}),
		);

		expect(response.status).toBe(415);
		expect(getSignedUploadUrl).not.toHaveBeenCalled();
	});
});
