import { createContext, runInContext, runInNewContext } from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import { renderToolbar } from "../../../src/visual-editing/toolbar.js";

// Regex patterns for HTML validation
const EDIT_TOGGLE_CHECKED_REGEX = /id="emdash-edit-toggle"\s+checked/;

function toolbarScript(html: string): string {
	const openTag = "<script>";
	const closeTag = "</script>";
	const start = html.indexOf(openTag);
	const end = html.indexOf(closeTag, start + openTag.length);
	if (start < 0 || end < 0) throw new Error("Toolbar script was not rendered");
	return html.slice(start + openTag.length, end);
}

function actionToolbar(): string {
	return renderToolbar({ editMode: true, isPreview: false, actionToken: "signed-action-token" });
}

describe("renderToolbar", () => {
	afterEach(() => vi.useRealTimers());
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

	it("publishes through the dedicated visual-editing boundary", () => {
		const html = actionToolbar();
		expect(html).toContain("/_emdash/api/visual-editing/content/");
		expect(html).not.toContain("X-EmDash-Action-Origin");
		expect(html).toContain('"X-EmDash-Visual-Action": visualActionToken');
		expect(html).toContain('visualActionToken = "signed-action-token"');
	});

	it("renews the action token and shows recovery when attestation expires", () => {
		const html = actionToolbar();
		expect(html).toContain("/_emdash/api/visual-editing/action-token");
		expect(html).toContain("scheduleVisualActionTokenRefresh(240000)");
		expect(html).toContain("Editing session expired. Refresh the page to continue.");
		expect(html).toContain("res.status === 401 || res.status === 403");
	});

	it("keeps renewal retries bounded and stops after authentication expires", async () => {
		vi.useFakeTimers();
		const html = actionToolbar();
		const script = toolbarScript(html);
		const refreshStart = script.indexOf("var visualActionToken");
		const refreshEnd = script.indexOf("var dismissBtn");
		expect(refreshStart).toBeGreaterThanOrEqual(0);
		expect(refreshEnd).toBeGreaterThan(refreshStart);
		const statusEl = { innerHTML: "" };
		const publishBtn = { disabled: false, textContent: "Publish" };
		const ecFetch = vi
			.fn()
			.mockResolvedValueOnce({ ok: false, status: 500 })
			.mockResolvedValueOnce({ ok: false, status: 500 })
			.mockResolvedValueOnce({ ok: false, status: 401 });

		runInNewContext(script.slice(refreshStart, refreshEnd), {
			statusEl,
			publishBtn,
			ecFetch,
			setTimeout,
			clearTimeout,
			console,
		});
		expect(vi.getTimerCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(240_000);
		expect(ecFetch).toHaveBeenCalledTimes(1);
		expect(vi.getTimerCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(ecFetch).toHaveBeenCalledTimes(2);
		expect(vi.getTimerCount()).toBe(1);

		await vi.advanceTimersByTimeAsync(30_000);
		expect(ecFetch).toHaveBeenCalledTimes(3);
		expect(vi.getTimerCount()).toBe(0);
		expect(statusEl.innerHTML).toContain("Editing session expired");
		expect(publishBtn).toEqual({ disabled: true, textContent: "Refresh page" });
	});

	it.each([
		[
			"permission denial",
			{ code: "FORBIDDEN", message: "You cannot publish this entry" },
			{
				disabled: false,
				textContent: "Publish",
				status: "You cannot publish this entry",
				timers: 1,
			},
		],
		[
			"expired attestation",
			{ code: "VISUAL_ACTION_TOKEN_INVALID", message: "Token expired" },
			{ disabled: true, textContent: "Refresh page", status: "Editing session expired", timers: 0 },
		],
	])("distinguishes publish %s from token expiry", async (_label, error, expected) => {
		vi.useFakeTimers();
		const html = actionToolbar();
		const script = toolbarScript(html);
		const refreshStart = script.indexOf("var visualActionToken");
		const refreshEnd = script.indexOf("var dismissBtn");
		const publishStart = script.indexOf("function publish(");
		const publishEnd = script.indexOf("// Edit mode toggle");
		const statusEl = { innerHTML: "", textContent: "" };
		const publishBtn = { disabled: false, textContent: "Publish" };
		const ecFetch = vi.fn().mockResolvedValue({
			ok: false,
			status: 403,
			json: () => Promise.resolve({ success: false, error }),
		});
		const context = createContext({
			statusEl,
			publishBtn,
			ecFetch,
			setTimeout,
			clearTimeout,
			console,
			pendingSavePromise: null,
		});
		runInContext(script.slice(refreshStart, refreshEnd), context);
		runInContext(`${script.slice(publishStart, publishEnd)}\npublish("posts", "post-1");`, context);
		await vi.advanceTimersByTimeAsync(0);

		expect(ecFetch).toHaveBeenCalledTimes(1);
		expect(publishBtn).toMatchObject({
			disabled: expected.disabled,
			textContent: expected.textContent,
		});
		expect(`${statusEl.innerHTML}${statusEl.textContent}`).toContain(expected.status);
		expect(vi.getTimerCount()).toBe(expected.timers);
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

	it("unwraps the { success, data } envelope returned by /_emdash/api/manifest", () => {
		// Regression for #103 / #445: the manifest endpoint wraps the payload in
		// { success, data: manifest } (ApiResponse shape), but getFieldKind reads
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
});
