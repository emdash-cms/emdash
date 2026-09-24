import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { SandboxedContentEditorActions } from "../../src/components/SandboxedContentEditorActions.js";
import { SandboxedContentEditorPanel } from "../../src/components/SandboxedContentEditorPanel.js";
import { render } from "../utils/render.js";

function Wrapper({ children }: React.PropsWithChildren) {
	return <Toasty>{children}</Toasty>;
}

afterEach(() => vi.unstubAllGlobals());

describe("SandboxedContentEditorPanel", () => {
	it("loads lazily once and sends only the panel interaction", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ data: { blocks: [{ type: "header", text: "Saved findings" }] } }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const screen = await render(
			<SandboxedContentEditorPanel
				pluginId="content-guard"
				panelId="findings"
				title="Findings"
				collection="posts"
				entryId="post-1"
				versionToken="v1"
				locale="ar"
			/>,
			{ wrapper: Wrapper },
		);

		expect(fetchMock).not.toHaveBeenCalled();
		await userEvent.click(screen.getByRole("button", { name: "Findings" }));
		await expect.element(screen.getByRole("heading", { name: "Saved findings" })).toBeVisible();
		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({
			type: "panel_load",
		});
		expect(String(fetchMock.mock.calls[0]?.[0])).toContain("?locale=ar");

		await userEvent.click(screen.getByRole("button", { name: "Findings" }));
		await userEvent.click(screen.getByRole("button", { name: "Findings" }));
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("captures draft data only after an explicit panel action", async () => {
		const fetchMock = vi
			.fn<() => Promise<Response>>()
			.mockResolvedValueOnce(
				Response.json({
					data: {
						blocks: [
							{
								type: "actions",
								elements: [{ type: "button", action_id: "translate", label: "Translate" }],
							},
						],
					},
				}),
			)
			.mockResolvedValueOnce(
				Response.json({
					data: {
						blocks: [],
						patch: {
							type: "editor-draft-patch",
							operations: [{ op: "set", field: "title", value: "Translated" }],
						},
						editorInvocation: {
							entryId: "post-1",
							locale: "en",
							baseRevision: "rev-1",
							generation: 3,
							invocationId: "invocation_123456",
						},
					},
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const captureDraft = vi.fn(() => ({
			collection: "posts",
			entryId: "post-1",
			locale: "en",
			baseRevision: "rev-1",
			generation: 3,
			invocationId: "invocation_123456",
			fields: { title: "Unsaved" },
		}));
		const onDraftResponse = vi.fn();
		const screen = await render(
			<SandboxedContentEditorPanel
				pluginId="translator"
				panelId="translation"
				title="Translation"
				collection="posts"
				entryId="post-1"
				locale="en"
				draftAccess={{ read: { fields: ["title"] }, patch: { fields: ["title"] } }}
				captureDraft={captureDraft}
				onDraftResponse={onDraftResponse}
			/>,
			{ wrapper: Wrapper },
		);
		await userEvent.click(screen.getByRole("button", { name: "Translation" }));
		await expect.element(screen.getByRole("button", { name: "Translate" })).toBeVisible();
		expect(captureDraft).not.toHaveBeenCalled();
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual({ type: "panel_load" });
		await userEvent.click(screen.getByRole("button", { name: "Translate" }));
		await vi.waitFor(() => expect(onDraftResponse).toHaveBeenCalledTimes(1));
		expect(captureDraft).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body))).toMatchObject({
			type: "block_action",
			action_id: "translate",
			draft: { fields: { title: "Unsaved" } },
		});
	});

	it("isolates a failed load and retries without remounting the editor", async () => {
		const fetchMock = vi
			.fn<() => Promise<Response>>()
			.mockResolvedValueOnce(new Response(null, { status: 502 }))
			.mockResolvedValueOnce(
				Response.json({ data: { blocks: [{ type: "header", text: "Recovered" }] } }),
			);
		vi.stubGlobal("fetch", fetchMock);
		const screen = await render(
			<SandboxedContentEditorPanel
				pluginId="content-guard"
				panelId="findings"
				title="Findings"
				collection="posts"
				entryId="post-1"
				versionToken="v1"
			/>,
			{ wrapper: Wrapper },
		);
		await userEvent.click(screen.getByRole("button", { name: "Findings" }));
		await expect.element(screen.getByRole("alert")).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		await expect.element(screen.getByRole("heading", { name: "Recovered" })).toBeVisible();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("applies panel refresh and safe navigation terminal effects", async () => {
		const onEntryRefresh = vi.fn();
		const open = vi.spyOn(window, "open").mockImplementation(() => null);
		const fetchMock = vi
			.fn<() => Promise<Response>>()
			.mockResolvedValueOnce(Response.json({ data: { blocks: [], refresh: true } }))
			.mockResolvedValueOnce(
				Response.json({
					data: {
						blocks: [],
						navigate: { kind: "external", url: "https://example.com/report" },
					},
				}),
			);
		vi.stubGlobal("fetch", fetchMock);
		const screen = await render(
			<SandboxedContentEditorPanel
				pluginId="content-guard"
				panelId="findings"
				title="Findings"
				collection="posts"
				entryId="post-1"
				versionToken="v1"
				onEntryRefresh={onEntryRefresh}
			/>,
			{ wrapper: Wrapper },
		);
		const trigger = screen.getByRole("button", { name: "Findings" });
		await userEvent.click(trigger);
		await vi.waitFor(() => expect(onEntryRefresh).toHaveBeenCalledTimes(1));
		await userEvent.click(trigger);
		await screen.rerender(
			<SandboxedContentEditorPanel
				pluginId="content-guard"
				panelId="findings"
				title="Findings"
				collection="posts"
				entryId="post-1"
				versionToken="v2"
				onEntryRefresh={onEntryRefresh}
			/>,
		);
		await userEvent.click(trigger);
		await vi.waitFor(() =>
			expect(open).toHaveBeenCalledWith(
				"https://example.com/report",
				"_blank",
				"noopener,noreferrer",
			),
		);
	});

	it("refreshes an open panel without collapsing after the saved version changes", async () => {
		const first = Promise.withResolvers<Response>();
		const second = Promise.withResolvers<Response>();
		const fetchMock = vi
			.fn<() => Promise<Response>>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		vi.stubGlobal("fetch", fetchMock);
		const screen = await render(
			<SandboxedContentEditorPanel
				pluginId="content-guard"
				panelId="findings"
				title="Findings"
				collection="posts"
				entryId="post-1"
				versionToken="v1"
			/>,
			{ wrapper: Wrapper },
		);
		await userEvent.click(screen.getByRole("button", { name: "Findings" }));
		await screen.rerender(
			<SandboxedContentEditorPanel
				pluginId="content-guard"
				panelId="findings"
				title="Findings"
				collection="posts"
				entryId="post-1"
				versionToken="v2"
			/>,
		);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await expect
			.element(screen.getByRole("button", { name: "Findings" }))
			.toHaveAttribute("aria-expanded", "true");
		second.resolve(Response.json({ data: { blocks: [{ type: "header", text: "Second" }] } }));
		await expect.element(screen.getByRole("heading", { name: "Second" })).toBeVisible();
		first.resolve(Response.json({ data: { blocks: [{ type: "header", text: "First" }] } }));
		await expect.element(screen.getByRole("heading", { name: "First" })).not.toBeInTheDocument();
	});

	it("loads the latest version after a closed panel changes while loading", async () => {
		const first = Promise.withResolvers<Response>();
		const second = Promise.withResolvers<Response>();
		const fetchMock = vi
			.fn<() => Promise<Response>>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		vi.stubGlobal("fetch", fetchMock);
		const screen = await render(
			<SandboxedContentEditorPanel
				pluginId="content-guard"
				panelId="findings"
				title="Findings"
				collection="posts"
				entryId="post-1"
				versionToken="v1"
			/>,
			{ wrapper: Wrapper },
		);
		const trigger = screen.getByRole("button", { name: "Findings" });
		await userEvent.click(trigger);
		await userEvent.click(trigger);
		await screen.rerender(
			<SandboxedContentEditorPanel
				pluginId="content-guard"
				panelId="findings"
				title="Findings"
				collection="posts"
				entryId="post-1"
				versionToken="v2"
			/>,
		);
		await userEvent.click(trigger);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		second.resolve(Response.json({ data: { blocks: [{ type: "header", text: "Latest" }] } }));
		await expect.element(screen.getByRole("heading", { name: "Latest" })).toBeVisible();
		first.resolve(Response.json({ data: { blocks: [{ type: "header", text: "Stale" }] } }));
		await expect.element(screen.getByRole("heading", { name: "Stale" })).not.toBeInTheDocument();
	});

	it("retries after closing a panel while its initial load is pending", async () => {
		const first = Promise.withResolvers<Response>();
		const second = Promise.withResolvers<Response>();
		const fetchMock = vi
			.fn<() => Promise<Response>>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		vi.stubGlobal("fetch", fetchMock);
		const screen = await render(
			<SandboxedContentEditorPanel
				pluginId="content-guard"
				panelId="findings"
				title="Findings"
				collection="posts"
				entryId="post-1"
				versionToken="v1"
			/>,
			{ wrapper: Wrapper },
		);
		const trigger = screen.getByRole("button", { name: "Findings" });
		await userEvent.click(trigger);
		await userEvent.click(trigger);
		await userEvent.click(trigger);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		second.resolve(Response.json({ data: { blocks: [{ type: "header", text: "Retried" }] } }));
		await expect.element(screen.getByRole("heading", { name: "Retried" })).toBeVisible();
		first.resolve(Response.json({ data: { blocks: [{ type: "header", text: "Stale" }] } }));
		await expect.element(screen.getByRole("heading", { name: "Stale" })).not.toBeInTheDocument();
	});
});

describe("SandboxedContentEditorActions", () => {
	it("allows a draft-aware action with unsaved changes and attaches one explicit snapshot", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({ data: { toast: { type: "success", message: "Proposed" } } }),
		);
		vi.stubGlobal("fetch", fetchMock);
		const captureDraft = vi.fn(() => ({
			collection: "posts",
			entryId: "post-1",
			locale: "en",
			baseRevision: "rev-1",
			generation: 1,
			invocationId: "invocation_123456",
			fields: { title: "Unsaved" },
		}));
		const screen = await render(
			<SandboxedContentEditorActions
				actions={[
					{
						pluginId: "translator",
						extension: {
							id: "translate",
							label: "Translate draft",
							route: "translate",
							placement: "toolbar",
							draft: { read: { fields: ["title"] }, patch: { fields: ["title"] } },
						},
					},
				]}
				collection="posts"
				entryId="post-1"
				locale="en"
				hasUnsavedChanges
				captureDraft={captureDraft}
			/>,
			{ wrapper: Wrapper },
		);
		await userEvent.click(screen.getByRole("button", { name: "Translate draft" }));
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		expect(captureDraft).toHaveBeenCalledTimes(1);
		expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toMatchObject({
			draft: { fields: { title: "Unsaved" } },
		});
	});

	it("does not invoke actions while the editor has unsaved changes", async () => {
		const fetchMock = vi.fn();
		vi.stubGlobal("fetch", fetchMock);
		const screen = await render(
			<SandboxedContentEditorActions
				actions={[
					{
						pluginId: "content-guard",
						extension: {
							id: "inspect",
							label: "Inspect saved entry",
							route: "inspect",
							placement: "toolbar",
						},
					},
				]}
				collection="posts"
				entryId="post-1"
				disabled
			/>,
			{ wrapper: Wrapper },
		);
		const action = screen.getByRole("button", { name: "Inspect saved entry" });
		await expect.element(action).toBeDisabled();
		action.element().click();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("requires manifest confirmation before invoking a danger action", async () => {
		const fetchMock = vi.fn(async () =>
			Response.json({
				data: { refresh: true, toast: { type: "success", message: "Entry refreshed" } },
			}),
		);
		vi.stubGlobal("fetch", fetchMock);
		const onEntryRefresh = vi.fn();
		const screen = await render(
			<SandboxedContentEditorActions
				actions={[
					{
						pluginId: "content-guard",
						extension: {
							id: "repair",
							label: "Repair entry",
							route: "repair",
							placement: "toolbar",
							style: "danger",
							confirm: {
								title: "Repair entry?",
								text: "This changes the saved entry.",
								confirm: "Repair",
								deny: "Cancel",
							},
						},
					},
				]}
				collection="posts"
				entryId="post-1"
				locale="en"
				onEntryRefresh={onEntryRefresh}
			/>,
			{ wrapper: Wrapper },
		);

		await userEvent.click(screen.getByRole("button", { name: "Repair entry" }));
		expect(fetchMock).not.toHaveBeenCalled();
		const dialog = screen.getByRole("alertdialog");
		await expect.element(dialog).toBeVisible();
		dialog.getByRole("button", { name: "Repair" }).element().click();
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
		await vi.waitFor(() => expect(onEntryRefresh).toHaveBeenCalledTimes(1));
	});
});
