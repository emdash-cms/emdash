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
			/>,
			{ wrapper: Wrapper },
		);
		await userEvent.click(screen.getByRole("button", { name: "Findings" }));
		await expect.element(screen.getByRole("alert")).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		await expect.element(screen.getByRole("heading", { name: "Recovered" })).toBeVisible();
		expect(fetchMock).toHaveBeenCalledTimes(2);
	});

	it("ignores a panel response after the saved entry changes", async () => {
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
				entryId="post-2"
			/>,
		);
		await userEvent.click(screen.getByRole("button", { name: "Findings" }));
		second.resolve(Response.json({ data: { blocks: [{ type: "header", text: "Second" }] } }));
		await expect.element(screen.getByRole("heading", { name: "Second" })).toBeVisible();
		first.resolve(Response.json({ data: { blocks: [{ type: "header", text: "First" }] } }));
		await expect.element(screen.getByRole("heading", { name: "First" })).not.toBeInTheDocument();
	});
});

describe("SandboxedContentEditorActions", () => {
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
