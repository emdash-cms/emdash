import { describe, it, expect } from "vitest";

import { renderPlaygroundToolbar } from "../../src/db/playground-toolbar.js";

const BASE_CONFIG = {
	createdAt: "2026-03-16T12:00:00.000Z",
	ttl: 3600,
	editMode: false,
};

describe("renderPlaygroundToolbar", () => {
	it("renders HTML with data attributes", () => {
		const html = renderPlaygroundToolbar(BASE_CONFIG);

		expect(html).toContain('id="emdash-playground-toolbar"');
		expect(html).toContain('data-created-at="2026-03-16T12:00:00.000Z"');
		expect(html).toContain('data-ttl="3600"');
	});

	it("renders the playground badge", () => {
		const html = renderPlaygroundToolbar(BASE_CONFIG);
		expect(html).toContain("Playground");
	});

	it("renders the deploy CTA link", () => {
		const html = renderPlaygroundToolbar(BASE_CONFIG);
		expect(html).toContain("Deploy your own");
		expect(html).toContain("github.com/emdash-cms/emdash");
	});

	it("renders reset and dismiss buttons", () => {
		const html = renderPlaygroundToolbar(BASE_CONFIG);
		expect(html).toContain('id="ec-pg-reset"');
		expect(html).toContain('id="ec-pg-dismiss"');
		expect(html).toContain("/_playground/reset");
	});

	it("escapes HTML in data attributes", () => {
		const html = renderPlaygroundToolbar({
			...BASE_CONFIG,
			createdAt: '"<script>alert(1)</script>',
		});

		expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
		expect(html).not.toContain('data-created-at="<script>');
	});

	it("includes countdown script", () => {
		const html = renderPlaygroundToolbar(BASE_CONFIG);
		expect(html).toContain("<script>");
		expect(html).toContain("getRemaining");
		expect(html).toContain("formatRemaining");
	});

	it("renders edit toggle unchecked when editMode is false", () => {
		const html = renderPlaygroundToolbar({ ...BASE_CONFIG, editMode: false });
		expect(html).toContain('id="ec-pg-edit-toggle"');
		expect(html).toContain('data-edit-mode="false"');
		expect(html).not.toContain('id="ec-pg-edit-toggle" checked');
	});

	it("renders edit toggle checked when editMode is true", () => {
		const html = renderPlaygroundToolbar({ ...BASE_CONFIG, editMode: true });
		expect(html).toContain('data-edit-mode="true"');
		expect(html).toContain('id="ec-pg-edit-toggle" checked');
	});

	it("includes edit mode hover styles for data-emdash-ref elements", () => {
		const html = renderPlaygroundToolbar(BASE_CONFIG);
		expect(html).toContain("[data-emdash-ref]");
		expect(html).toContain('data-edit-mode="true"');
	});
});
