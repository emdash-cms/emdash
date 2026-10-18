import { afterEach, describe, expect, it, vi } from "vitest";

import { openPreviewWindow } from "../../src/lib/preview-window.js";

function stubOpen(returned: Partial<Window> | null) {
	return vi.spyOn(window, "open").mockReturnValue(returned as Window | null);
}

describe("openPreviewWindow", () => {
	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reuses one named tab per entry", () => {
		const open = stubOpen({ opener: window, focus: vi.fn() });

		openPreviewWindow("/posts/hello?_preview=a", "posts", "01ABC");
		openPreviewWindow("/posts/hello?_preview=b", "posts", "01ABC");
		openPreviewWindow("/pages/about?_preview=c", "pages", "01XYZ");

		const targets = open.mock.calls.map((call) => call[1]);
		expect(targets[0]).toBe(targets[1]);
		expect(targets[2]).not.toBe(targets[0]);
		expect(targets).not.toContain("_blank");
	});

	it("cuts the preview's link back to the admin and brings it to the front", () => {
		const preview = { opener: window as Window | null, focus: vi.fn() };
		stubOpen(preview);

		openPreviewWindow("/posts/hello", "posts", "01ABC");

		expect(preview.opener).toBeNull();
		expect(preview.focus).toHaveBeenCalledOnce();
	});

	it("does nothing more when the browser blocks the tab", () => {
		stubOpen(null);
		expect(() => openPreviewWindow("/posts/hello", "posts", "01ABC")).not.toThrow();
	});
});
