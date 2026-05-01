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

	it("unwraps the { data } envelope returned by /_emdash/api/manifest", () => {
		// Regression for #103 / #445: the manifest endpoint wraps the payload in
		// { data: manifest } (ApiResponse shape), but getFieldKind reads
		// manifest.collections directly. Without the unwrap, getFieldKind returns
		// null for every field kind, and every click on an edit annotation opens
		// the admin in a new tab instead of inline-editing.
		const html = renderToolbar({ editMode: true, isPreview: false });
		// The unwrap happens inside the fetchManifest .then() callback. Verify
		// the generated HTML contains the conditional unwrap rather than
		// assigning the raw response.
		expect(html).toMatch(/manifestCache\s*=\s*m\s*&&\s*m\.data\s*\?\s*m\.data\s*:\s*m/);
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

	describe("edit-mode toggle navigation (#878)", () => {
		// Regression for #878: clicking the edit toggle reloaded the page with
		// no effect because the toggle handler wrapped a same-URL navigation in
		// `document.startViewTransition`. View transitions are a same-document
		// SPA primitive — wrapping a cross-document navigation in one races
		// against the document unload and can leave the navigation cancelled
		// or served from the bfcache without re-running the server. The fix
		// uses `location.reload()` (which always revalidates) and skips the
		// view transition wrapper entirely.

		it("uses location.reload() to force a fresh server render", () => {
			const html = renderToolbar({ editMode: false, isPreview: false });
			// The toggle handler must call location.reload() — not
			// location.replace(location.href), which can be served from cache
			// or the bfcache without re-rendering the server response.
			expect(html).toMatch(/toggle\.addEventListener\("change"[\s\S]+?location\.reload\(\)/);
		});

		it("does not wrap the toggle reload in document.startViewTransition", () => {
			const html = renderToolbar({ editMode: false, isPreview: false });
			// Same-URL cross-document navigation wrapped in startViewTransition
			// is the source of the bug — view transitions are a same-document
			// SPA primitive and the spec leaves the navigation behaviour
			// undefined when the document unloads mid-transition. In Chromium
			// this races with the page unload and can leave the navigation
			// cancelled or served from cache. Extract the toggle change
			// handler and assert no view-transition wrapper appears in it.
			const toggleHandlerMatch = html.match(
				/toggle\.addEventListener\("change"[\s\S]+?\n\s{2,}\}\);/,
			);
			expect(toggleHandlerMatch, "toggle change handler must be present").not.toBeNull();
			const toggleHandler = toggleHandlerMatch![0];
			expect(toggleHandler).not.toContain("startViewTransition");
		});

		it("sets the edit-mode cookie before navigating", () => {
			const html = renderToolbar({ editMode: false, isPreview: false });
			// Cookie write must precede the navigation so the next request
			// carries the new value. Same-Site=Lax so the cookie travels on
			// top-level navigations (location.reload qualifies).
			expect(html).toContain('document.cookie = "emdash-edit-mode=true;path=/;samesite=lax"');
		});

		it("clears the edit-mode cookie when toggling off", () => {
			const html = renderToolbar({ editMode: true, isPreview: false });
			expect(html).toMatch(
				/document\.cookie = "emdash-edit-mode=;path=\/;expires=Thu, 01 Jan 1970/,
			);
		});
	});
});
