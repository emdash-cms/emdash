import { describe, expect, it } from "vitest";

import { renderToolbar } from "../../../src/visual-editing/toolbar.js";

// Regex patterns for HTML validation
const EDIT_TOGGLE_CHECKED_REGEX = /id="emdash-edit-toggle"\s+checked/;

describe("renderToolbar", () => {
	it("renders toolbar with edit mode off", () => {
		const html = renderToolbar({ editMode: false, isPreview: false });
		expect(html).toContain('id="emdash-toolbar"');
		expect(html).toContain('data-edit-mode="false"');
		expect(html).not.toMatch(EDIT_TOGGLE_CHECKED_REGEX);
	});

	it("renders toolbar with edit mode on", () => {
		const html = renderToolbar({ editMode: true, isPreview: false });
		expect(html).toContain('data-edit-mode="true"');
		expect(html).toContain("checked");
	});

	it("stores preview state as data attribute", () => {
		const html = renderToolbar({ editMode: false, isPreview: true });
		expect(html).toContain('data-preview="true"');
	});

	it("includes toggle switch", () => {
		const html = renderToolbar({ editMode: false, isPreview: false });
		expect(html).toContain('id="emdash-edit-toggle"');
		expect(html).toContain("emdash-tb-toggle");
	});

	it("includes publish button (hidden by default)", () => {
		const html = renderToolbar({ editMode: true, isPreview: false });
		expect(html).toContain('id="emdash-tb-publish"');
		expect(html).toContain('style="display:none"');
	});

	it("includes save status element", () => {
		const html = renderToolbar({ editMode: true, isPreview: false });
		expect(html).toContain('id="emdash-tb-save-status"');
	});

	it("includes inline editing script with save state tracking", () => {
		const html = renderToolbar({ editMode: true, isPreview: false });
		expect(html).toContain("<script>");
		expect(html).toContain("setSaveState");
		expect(html).toContain("unsaved");
		expect(html).toContain("contentEditable");
	});

	it("includes text cursor for editable hover", () => {
		const html = renderToolbar({ editMode: true, isPreview: false });
		expect(html).toContain("[data-emdash-ref]:hover");
		expect(html).toContain("cursor: text");
	});

	it("includes manifest fetching for field type lookup", () => {
		const html = renderToolbar({ editMode: true, isPreview: false });
		expect(html).toContain("fetchManifest");
		expect(html).toContain("/_emdash/api/manifest");
	});

	it("skips toolbar interception for portableText (inline editor)", () => {
		const html = renderToolbar({ editMode: true, isPreview: false });
		expect(html).toContain("portableText");
	});

	it("includes entry status badge styles", () => {
		const html = renderToolbar({ editMode: true, isPreview: false });
		expect(html).toContain("emdash-tb-badge--draft");
		expect(html).toContain("emdash-tb-badge--published");
		expect(html).toContain("emdash-tb-badge--pending");
	});

	it("includes save state badge styles", () => {
		const html = renderToolbar({ editMode: true, isPreview: false });
		expect(html).toContain("emdash-tb-badge--unsaved");
		expect(html).toContain("emdash-tb-badge--saving");
		expect(html).toContain("emdash-tb-badge--saved");
		expect(html).toContain("emdash-tb-badge--error");
	});
});
