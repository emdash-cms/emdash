import { describe, expect, it } from "vitest";

import { unwrapResult } from "../../../src/api/error.js";

describe("transfer error statuses", () => {
	it("answers a transfer error code with its transfer status", async () => {
		const response = unwrapResult({
			success: false,
			error: { code: "TRANSFER_PLAN_DIGEST_MISMATCH", message: "Plan changed" },
		});
		expect(response.status).toBe(409);
		expect((await response.json()) as unknown).toMatchObject({
			error: { code: "TRANSFER_PLAN_DIGEST_MISMATCH" },
		});
	});
});
