/**
 * Integration tests for the configurable media upload size limit.
 *
 * Starts a server with maxUploadSize=1 MB and verifies that both
 * upload paths (direct multipart and signed-URL) enforce the limit.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
	assertNodeVersion,
	createTestServer,
	type TestServerContext,
} from "../server.js";

const PORT = 4398;
const ONE_MB = 1024 * 1024;

let ctx: TestServerContext;

beforeAll(async () => {
	assertNodeVersion();
	ctx = await createTestServer({
		port: PORT,
		seed: false,
		env: { EMDASH_MAX_UPLOAD_SIZE: String(ONE_MB) },
	});
}, 120_000);

afterAll(async () => {
	await ctx?.cleanup();
});

describe("direct multipart upload", () => {
	it("rejects a file that exceeds maxUploadSize with 413", async () => {
		const bigFile = new File([new Uint8Array(2 * ONE_MB)], "big.pdf", {
			type: "application/pdf",
		});
		const body = new FormData();
		body.append("file", bigFile);

		const res = await fetch(`${ctx.baseUrl}/_emdash/api/media`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${ctx.token}`,
				"X-EmDash-Request": "1",
			},
			body,
		});

		expect(res.status).toBe(413);
		const json = await res.json() as { error: { code: string } };
		expect(json.error.code).toBe("PAYLOAD_TOO_LARGE");
	});

	it("accepts a file within maxUploadSize", async () => {
		const smallFile = new File([new Uint8Array(512 * 1024)], "small.pdf", {
			type: "application/pdf",
		});
		const body = new FormData();
		body.append("file", smallFile);

		const res = await fetch(`${ctx.baseUrl}/_emdash/api/media`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${ctx.token}`,
				"X-EmDash-Request": "1",
			},
			body,
		});

		// 201 = created successfully
		expect(res.status).toBe(201);
	});
});

describe("signed-URL upload (upload-url endpoint)", () => {
	it("rejects a declared size that exceeds maxUploadSize with 400", async () => {
		const res = await fetch(`${ctx.baseUrl}/_emdash/api/media/upload-url`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${ctx.token}`,
				"X-EmDash-Request": "1",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				filename: "big.pdf",
				contentType: "application/pdf",
				size: 2 * ONE_MB,
			}),
		});

		expect(res.status).toBe(400);
		const json = await res.json() as { error: { code: string } };
		expect(json.error.code).toBe("VALIDATION_ERROR");
	});

	it("passes size validation for a declared size within maxUploadSize", async () => {
		// Local storage does not support signed URLs, so a valid-size request
		// proceeds past Zod validation and fails later with 501.
		const res = await fetch(`${ctx.baseUrl}/_emdash/api/media/upload-url`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${ctx.token}`,
				"X-EmDash-Request": "1",
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				filename: "ok.pdf",
				contentType: "application/pdf",
				size: 512 * 1024,
			}),
		});

		// 501 means the request passed size validation and hit the storage layer.
		// A size-rejection would produce 400.
		expect(res.status).toBe(501);
	});
});
