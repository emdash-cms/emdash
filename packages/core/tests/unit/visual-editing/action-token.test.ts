import { afterEach, describe, expect, it, vi } from "vitest";

import { generatePreviewToken } from "../../../src/preview/tokens.js";
import {
	generateVisualEditingActionToken,
	verifyVisualEditingActionToken,
} from "../../../src/visual-editing/action-token.js";

describe("visual editing action tokens", () => {
	afterEach(() => vi.useRealTimers());

	it("binds a short-lived token to the authenticated editor", async () => {
		vi.useFakeTimers({ now: new Date("2030-01-01T00:00:00.000Z") });
		const token = await generateVisualEditingActionToken("preview-secret", "editor-1");

		await expect(verifyVisualEditingActionToken(token, "preview-secret", "editor-1")).resolves.toBe(
			true,
		);
		await expect(verifyVisualEditingActionToken(token, "preview-secret", "editor-2")).resolves.toBe(
			false,
		);
		vi.setSystemTime(new Date("2030-01-01T00:05:01.000Z"));
		await expect(verifyVisualEditingActionToken(token, "preview-secret", "editor-1")).resolves.toBe(
			false,
		);
	});

	it("does not accept an ordinary preview token for the visual action domain", async () => {
		const previewToken = await generatePreviewToken({
			contentId: "visual-editing:editor-1",
			expiresIn: "5m",
			secret: "preview-secret",
		});

		await expect(
			verifyVisualEditingActionToken(previewToken, "preview-secret", "editor-1"),
		).resolves.toBe(false);
	});
});
