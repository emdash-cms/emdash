import { Input, Toasty } from "@cloudflare/kumo";
import type { Block } from "@emdash-cms/blocks";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { SandboxedContentEditorActions } from "../../src/components/SandboxedContentEditorActions.js";
import { SandboxedContentEditorPanel } from "../../src/components/SandboxedContentEditorPanel.js";
import { render } from "../utils/render.js";

function Wrapper({ children }: React.PropsWithChildren) {
	return <Toasty>{children}</Toasty>;
}

afterEach(() => vi.unstubAllGlobals());

const editableBlocks: Block[] = [
	{ type: "header", text: "Saved findings" },
	{
		type: "actions",
		elements: [
			{ type: "text_input", action_id: "prompt", label: "Prompt" },
			{ type: "button", action_id: "analyze", label: "Analyze" },
			{ type: "button", action_id: "rewrite", label: "Rewrite" },
		],
	},
];

function requestBody(fetchMock: ReturnType<typeof vi.fn<typeof fetch>>, index: number) {
	const body = fetchMock.mock.calls[index]?.[1]?.body;
	if (typeof body !== "string") throw new Error("Expected a JSON request body");
	return JSON.parse(body);
}

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

	it.each(["block_action", "form_submit"] as const)(
		"keeps controls visible with loading feedback while %s is pending",
		async (interactionType) => {
			const blocks: Block[] = [
				{ type: "header", text: "Saved findings" },
				{
					type: "actions",
					elements: [
						{ type: "button", action_id: "analyze", label: "Analyze" },
						{ type: "button", action_id: "rewrite", label: "Rewrite" },
					],
				},
				{
					type: "form",
					fields: [{ type: "text_input", action_id: "summary", label: "Summary" }],
					submit: { label: "Save findings", action_id: "save" },
				},
			];
			const pending = Promise.withResolvers<Response>();
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(Response.json({ data: { blocks } }))
				.mockReturnValueOnce(pending.promise);
			vi.stubGlobal("fetch", fetchMock);
			const panel = (versionToken: string) => (
				<SandboxedContentEditorPanel
					pluginId="content-guard"
					panelId="findings"
					title="Findings"
					collection="posts"
					entryId="post-1"
					versionToken={versionToken}
				/>
			);
			const screen = await render(panel("v1"), { wrapper: Wrapper });
			await userEvent.click(screen.getByRole("button", { name: "Findings", exact: true }));
			await expect.element(screen.getByRole("heading", { name: "Saved findings" })).toBeVisible();
			await screen.getByRole("textbox", { name: "Summary" }).fill("Keep my findings");
			const rewrite = screen.getByRole("button", { name: "Rewrite" }).element();
			const submit = screen.getByRole("button", { name: "Save findings" }).element();
			await userEvent.click(
				screen.getByRole("button", {
					name: interactionType === "block_action" ? "Analyze" : "Save findings",
				}),
			);
			await expect.element(screen.getByRole("status")).toHaveTextContent("Loading plugin panel");
			await expect.element(rewrite).toBeVisible();
			await expect.element(submit).toBeVisible();
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(requestBody(fetchMock, 1)).toMatchObject({
				type: interactionType,
			});
			expect(fetchMock.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);

			pending.resolve(
				Response.json({
					data: { blocks: [{ type: "header", text: "Updated findings" }, ...blocks.slice(1)] },
				}),
			);
			await expect.element(screen.getByRole("heading", { name: "Updated findings" })).toBeVisible();
			await expect.element(screen.getByRole("status")).toHaveTextContent("");
			await expect
				.element(screen.getByRole("textbox", { name: "Summary" }))
				.toHaveValue("Keep my findings");
			await expect.element(screen.getByRole("button", { name: "Rewrite" })).toBeVisible();
		},
	);

	it("clears interaction loading on failure and shows feedback during a manual retry", async () => {
		const interaction = Promise.withResolvers<Response>();
		const retry = Promise.withResolvers<Response>();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(
				Response.json({
					data: {
						blocks: [
							{
								type: "actions",
								elements: [{ type: "button", action_id: "analyze", label: "Analyze" }],
							},
						],
					},
				}),
			)
			.mockReturnValueOnce(interaction.promise)
			.mockReturnValueOnce(retry.promise);
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
		await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
		await expect.element(screen.getByRole("status")).toHaveTextContent("Loading plugin panel");
		interaction.resolve(new Response(null, { status: 502 }));
		await expect.element(screen.getByRole("alert")).toBeVisible();
		await expect.element(screen.getByRole("status")).toHaveTextContent("");
		await userEvent.click(screen.getByRole("button", { name: "Retry" }));
		await expect.element(screen.getByRole("button", { name: "Analyze" })).toBeVisible();
		await expect.element(screen.getByRole("status")).toHaveTextContent("Loading plugin panel");
		await expect.element(screen.getByRole("button", { name: "Retry" })).not.toBeInTheDocument();
		retry.resolve(Response.json({ data: { blocks: [{ type: "header", text: "Recovered" }] } }));
		await expect.element(screen.getByRole("heading", { name: "Recovered" })).toBeVisible();
		await expect.element(screen.getByRole("status")).toHaveTextContent("");
	});

	it.each(["click", "tab"] as const)(
		"sends the button action after the input blur finishes using %s without losing focus",
		async (method) => {
			const blur = Promise.withResolvers<Response>();
			const button = Promise.withResolvers<Response>();
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(Response.json({ data: { blocks: editableBlocks } }))
				.mockReturnValueOnce(blur.promise)
				.mockReturnValueOnce(button.promise);
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
			await screen.getByRole("textbox", { name: "Prompt" }).fill("Summarize this entry");
			const analyze = screen.getByRole("button", { name: "Analyze" });
			if (method === "tab") {
				await userEvent.keyboard("{Tab}");
				await expect.element(analyze).toHaveFocus();
				await userEvent.keyboard("{Enter}");
			} else {
				await userEvent.click(analyze);
			}
			await expect.element(analyze).toHaveFocus();
			await expect.element(analyze).toBeEnabled();
			await expect.element(screen.getByRole("textbox", { name: "Prompt" })).toBeVisible();
			await expect.element(screen.getByRole("status")).toHaveTextContent("Loading plugin panel");
			expect(fetchMock).toHaveBeenCalledTimes(2);
			expect(requestBody(fetchMock, 1)).toMatchObject({
				type: "block_action",
				action_id: "prompt",
				value: "Summarize this entry",
			});
			const signal = fetchMock.mock.calls[1]?.[1]?.signal;
			expect(signal?.aborted).toBe(false);

			blur.resolve(
				Response.json({
					data: { blocks: editableBlocks, toast: { type: "success", message: "Prompt received" } },
				}),
			);
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
			await expect.element(screen.getByText("Prompt received")).toBeVisible();
			expect(requestBody(fetchMock, 2)).toMatchObject({
				type: "block_action",
				action_id: "analyze",
			});
			expect(signal?.aborted).toBe(false);
			await expect.element(analyze).toHaveFocus();
			await expect.element(screen.getByRole("status")).toHaveTextContent("Loading plugin panel");
			button.resolve(
				Response.json({ data: { blocks: [{ type: "header", text: "Analysis complete" }] } }),
			);
			await expect
				.element(screen.getByRole("heading", { name: "Analysis complete" }))
				.toBeVisible();
			await expect.element(screen.getByRole("status")).toHaveTextContent("");
		},
	);

	it("keeps a loaded panel visible and focused during a silent version refresh", async () => {
		const first = Promise.withResolvers<Response>();
		const refresh = Promise.withResolvers<Response>();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(refresh.promise);
		vi.stubGlobal("fetch", fetchMock);
		const panel = (versionToken: string) => (
			<SandboxedContentEditorPanel
				pluginId="content-guard"
				panelId="findings"
				title="Findings"
				collection="posts"
				entryId="post-1"
				versionToken={versionToken}
			/>
		);
		const screen = await render(panel("v1"), { wrapper: Wrapper });
		await userEvent.click(screen.getByRole("button", { name: "Findings" }));
		await expect.element(screen.getByRole("status")).toHaveTextContent("Loading plugin panel");
		first.resolve(Response.json({ data: { blocks: editableBlocks } }));
		const prompt = screen.getByRole("textbox", { name: "Prompt" });
		await prompt.fill("Keep my prompt");
		await screen.rerender(panel("v2"));
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		expect(requestBody(fetchMock, 1)).toEqual({ type: "panel_load" });
		await expect.element(screen.getByRole("heading", { name: "Saved findings" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Analyze" })).toBeVisible();
		await expect.element(prompt).toHaveFocus();
		await expect.element(prompt).toHaveValue("Keep my prompt");
		await expect.element(screen.getByRole("status")).toHaveTextContent("");
		expect(screen.container.querySelector('[aria-busy="true"]')).toBeNull();
		refresh.resolve(
			Response.json({
				data: {
					blocks: [{ type: "header", text: "Refreshed findings" }, ...editableBlocks.slice(1)],
				},
			}),
		);
		await expect.element(screen.getByRole("heading", { name: "Refreshed findings" })).toBeVisible();
		await expect.element(prompt).toHaveValue("Keep my prompt");
		await expect.element(prompt).toHaveFocus();
	});

	it("skips superseded saved-version refreshes queued behind an action without cancelling its result", async () => {
		const action = Promise.withResolvers<Response>();
		const refresh = Promise.withResolvers<Response>();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ data: { blocks: editableBlocks } }))
			.mockReturnValueOnce(action.promise)
			.mockReturnValueOnce(refresh.promise);
		vi.stubGlobal("fetch", fetchMock);
		const panel = (versionToken: string) => (
			<SandboxedContentEditorPanel
				pluginId="content-guard"
				panelId="findings"
				title="Findings"
				collection="posts"
				entryId="post-1"
				versionToken={versionToken}
			/>
		);
		const screen = await render(panel("v1"), { wrapper: Wrapper });
		await userEvent.click(screen.getByRole("button", { name: "Findings" }));
		await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
		await screen.rerender(panel("v2"));
		await screen.rerender(panel("v3"));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		const signal = fetchMock.mock.calls[1]?.[1]?.signal;
		expect(signal?.aborted).toBe(false);
		await expect.element(screen.getByRole("status")).toHaveTextContent("Loading plugin panel");
		expect(screen.container.querySelector('[aria-busy="true"]')).not.toBeNull();
		action.resolve(
			Response.json({
				data: {
					blocks: [{ type: "header", text: "Action result" }],
					toast: { type: "success", message: "Action finished" },
				},
			}),
		);
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
		expect(requestBody(fetchMock, 2)).toEqual({ type: "panel_load" });
		expect(signal?.aborted).toBe(false);
		await expect.element(screen.getByRole("heading", { name: "Action result" })).toBeVisible();
		await expect.element(screen.getByText("Action finished")).toBeVisible();
		await expect.element(screen.getByRole("status")).toHaveTextContent("");
		expect(screen.container.querySelector('[aria-busy="true"]')).toBeNull();
		refresh.resolve(
			Response.json({ data: { blocks: [{ type: "header", text: "Latest saved version" }] } }),
		);
		await expect
			.element(screen.getByRole("heading", { name: "Latest saved version" }))
			.toBeVisible();
	});

	it("continues queued actions after a failed interaction", async () => {
		const first = Promise.withResolvers<Response>();
		const second = Promise.withResolvers<Response>();
		const third = Promise.withResolvers<Response>();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ data: { blocks: editableBlocks } }))
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise)
			.mockReturnValueOnce(third.promise);
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
		await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
		await userEvent.click(screen.getByRole("button", { name: "Rewrite" }));
		await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		first.reject(new Error("Connection lost"));
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
		expect(requestBody(fetchMock, 2)).toMatchObject({ action_id: "rewrite" });
		await expect.element(screen.getByText("Plugin panel unavailable.")).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Rewrite" })).toBeVisible();
		await expect.element(screen.getByRole("status")).toHaveTextContent("Loading plugin panel");
		second.resolve(Response.json({ data: { blocks: editableBlocks } }));
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
		expect(requestBody(fetchMock, 3)).toMatchObject({ action_id: "analyze" });
		await expect.element(screen.getByRole("status")).toHaveTextContent("Loading plugin panel");
		third.resolve(Response.json({ data: { blocks: editableBlocks } }));
		await expect.element(screen.getByRole("status")).toHaveTextContent("");
		await expect.element(screen.getByText("Plugin panel unavailable.")).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Rewrite" })).toBeVisible();
	});

	it("preserves form values when a silent refresh fails with an action queued", async () => {
		const blocks: Block[] = [
			{
				type: "form",
				fields: [{ type: "text_input", action_id: "summary", label: "Summary" }],
				submit: { label: "Save findings", action_id: "save" },
			},
			{
				type: "actions",
				elements: [{ type: "button", action_id: "analyze", label: "Analyze" }],
			},
		];
		const refresh = Promise.withResolvers<Response>();
		const action = Promise.withResolvers<Response>();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ data: { blocks } }))
			.mockReturnValueOnce(refresh.promise)
			.mockReturnValueOnce(action.promise);
		vi.stubGlobal("fetch", fetchMock);
		const panel = (versionToken: string) => (
			<SandboxedContentEditorPanel
				pluginId="content-guard"
				panelId="findings"
				title="Findings"
				collection="posts"
				entryId="post-1"
				versionToken={versionToken}
			/>
		);
		const screen = await render(panel("v1"), { wrapper: Wrapper });
		await userEvent.click(screen.getByRole("button", { name: "Findings" }));
		await screen.getByRole("textbox", { name: "Summary" }).fill("Keep my findings");
		await screen.rerender(panel("v2"));
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		refresh.resolve(new Response(null, { status: 502 }));
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
		expect(requestBody(fetchMock, 2)).toMatchObject({ type: "block_action", action_id: "analyze" });
		await expect.element(screen.getByText("Plugin panel unavailable.")).toBeVisible();
		await expect
			.element(screen.getByRole("textbox", { name: "Summary" }))
			.toHaveValue("Keep my findings");
		await expect.element(screen.getByRole("button", { name: "Analyze" })).toHaveFocus();
		action.resolve(Response.json({ data: { blocks } }));
		await expect.element(screen.getByRole("status")).toHaveTextContent("");
		await expect
			.element(screen.getByRole("textbox", { name: "Summary" }))
			.toHaveValue("Keep my findings");
	});

	it.each(["close", "entry change", "unmount"] as const)(
		"cancels active and queued work on %s",
		async (reason) => {
			const pending = Promise.withResolvers<Response>();
			const onEntryRefresh = vi.fn();
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(Response.json({ data: { blocks: editableBlocks } }))
				.mockReturnValueOnce(pending.promise)
				.mockResolvedValueOnce(
					Response.json({ data: { blocks: [{ type: "header", text: "Fresh findings" }] } }),
				);
			vi.stubGlobal("fetch", fetchMock);
			const panel = (entryId: string) => (
				<SandboxedContentEditorPanel
					pluginId="content-guard"
					panelId="findings"
					title="Findings"
					collection="posts"
					entryId={entryId}
					onEntryRefresh={onEntryRefresh}
				/>
			);
			const screen = await render(panel("post-1"), { wrapper: Wrapper });
			const trigger = screen.getByRole("button", { name: "Findings" });
			await userEvent.click(trigger);
			await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
			await userEvent.click(screen.getByRole("button", { name: "Rewrite" }));
			expect(fetchMock).toHaveBeenCalledTimes(2);
			const signal = fetchMock.mock.calls[1]?.[1]?.signal;
			if (reason === "close") await userEvent.click(trigger);
			else if (reason === "entry change") await screen.rerender(panel("post-2"));
			else await screen.unmount();
			expect(signal?.aborted).toBe(true);
			if (reason !== "unmount") {
				await userEvent.click(trigger);
				await expect.element(screen.getByRole("heading", { name: "Fresh findings" })).toBeVisible();
				expect(requestBody(fetchMock, 2)).toEqual({ type: "panel_load" });
			}
			pending.resolve(
				Response.json({
					data: { blocks: [{ type: "header", text: "Stale findings" }], refresh: true },
				}),
			);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(fetchMock).toHaveBeenCalledTimes(reason === "unmount" ? 2 : 3);
			expect(onEntryRefresh).not.toHaveBeenCalled();
			if (reason !== "unmount") {
				await expect.element(screen.getByRole("heading", { name: "Fresh findings" })).toBeVisible();
				await expect.element(screen.getByRole("status")).toHaveTextContent("");
			}
		},
	);

	it.each(["block_action", "form_submit"] as const)(
		"skips only consecutive duplicate pending %s interactions",
		async (type) => {
			const blocks: Block[] = [
				{
					type: "actions",
					elements: [
						{
							type: "button",
							action_id: "search",
							label: "Search",
							value: { query: "same", filters: ["a", "b"] },
						},
						{ type: "button", action_id: "rewrite", label: "Rewrite" },
					],
				},
				{
					type: "form",
					block_id: "summary",
					fields: [
						{ type: "text_input", action_id: "summary", label: "Summary", initial_value: "draft" },
					],
					submit: { action_id: "save", label: "Save findings" },
				},
			];
			const first = Promise.withResolvers<Response>();
			const second = Promise.withResolvers<Response>();
			const third = Promise.withResolvers<Response>();
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(Response.json({ data: { blocks } }))
				.mockReturnValueOnce(first.promise)
				.mockReturnValueOnce(second.promise)
				.mockReturnValueOnce(third.promise)
				.mockResolvedValueOnce(Response.json({ data: { blocks } }));
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
			await userEvent.click(screen.getByRole("button", { name: "Findings", exact: true }));
			const submit = screen.getByRole("button", {
				name: type === "block_action" ? "Search" : "Save findings",
				exact: true,
			});
			const rewrite = screen.getByRole("button", { name: "Rewrite" });
			await userEvent.click(submit);
			await userEvent.click(submit);
			await userEvent.click(rewrite);
			await userEvent.click(rewrite);
			await userEvent.click(submit);
			await userEvent.click(submit);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			first.resolve(Response.json({ data: { blocks } }));
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
			expect(requestBody(fetchMock, 2)).toMatchObject({ action_id: "rewrite" });
			second.resolve(Response.json({ data: { blocks } }));
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
			expect(requestBody(fetchMock, 3)).toEqual(requestBody(fetchMock, 1));
			third.resolve(Response.json({ data: { blocks } }));
			await expect.element(screen.getByRole("status")).toHaveTextContent("");
			expect(fetchMock).toHaveBeenCalledTimes(4);
			await userEvent.click(submit);
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(5));
		},
	);

	it("accepts search again after an intervening changed input blur", async () => {
		const requests = Array.from({ length: 3 }, () => Promise.withResolvers<Response>());
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ data: { blocks: editableBlocks } }));
		for (const request of requests) fetchMock.mockReturnValueOnce(request.promise);
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
		await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
		await screen.getByRole("textbox", { name: "Prompt" }).fill("Changed prompt");
		await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		requests[0]?.resolve(Response.json({ data: { blocks: editableBlocks } }));
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
		expect(requestBody(fetchMock, 2)).toMatchObject({
			action_id: "prompt",
			value: "Changed prompt",
		});
		requests[1]?.resolve(Response.json({ data: { blocks: editableBlocks } }));
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
		expect(requestBody(fetchMock, 3)).toEqual(requestBody(fetchMock, 1));
		requests[2]?.resolve(Response.json({ data: { blocks: editableBlocks } }));
		await expect.element(screen.getByRole("status")).toHaveTextContent("");
	});

	it("compares structured action values by content and accepts changed values", async () => {
		const values = [
			{ query: "same", filters: ["a", "b"] },
			{ filters: ["a", "b"], query: "same" },
			{ query: "same", filters: ["b", "a"] },
		];
		const blocks: Block[] = values.map((value, index) => ({
			type: "actions",
			block_id: `group-${index}`,
			elements: [{ type: "button", action_id: "search", label: `Search ${index}`, value }],
		}));
		const first = Promise.withResolvers<Response>();
		const second = Promise.withResolvers<Response>();
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ data: { blocks } }))
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
		for (let index = 0; index < values.length; index++)
			await userEvent.click(screen.getByRole("button", { name: `Search ${index}` }));
		expect(fetchMock).toHaveBeenCalledTimes(2);
		first.resolve(Response.json({ data: { blocks } }));
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
		expect(requestBody(fetchMock, 2)).toMatchObject({ value: values[2] });
		second.resolve(Response.json({ data: { blocks } }));
		await expect.element(screen.getByRole("status")).toHaveTextContent("");
		expect(fetchMock).toHaveBeenCalledTimes(3);
	});

	it("accepts changed form values, block identities, and interaction types", async () => {
		const blocks: Block[] = [
			...["a", "b"].map(
				(id): Block => ({
					type: "form",
					block_id: id,
					fields: [
						{
							type: "text_input",
							action_id: "summary",
							label: `Summary ${id}`,
							initial_value: "same",
						},
					],
					submit: { action_id: "save", label: `Save ${id}` },
				}),
			),
			{ type: "actions", elements: [{ type: "button", action_id: "save", label: "Save button" }] },
		];
		const requests = Array.from({ length: 4 }, () => Promise.withResolvers<Response>());
		const fetchMock = vi
			.fn<typeof fetch>()
			.mockResolvedValueOnce(Response.json({ data: { blocks } }));
		for (const request of requests) fetchMock.mockReturnValueOnce(request.promise);
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
		await userEvent.click(screen.getByRole("button", { name: "Save a", exact: true }));
		await userEvent.click(screen.getByRole("button", { name: "Save b", exact: true }));
		await screen.getByRole("textbox", { name: "Summary b" }).fill("changed");
		await userEvent.click(screen.getByRole("button", { name: "Save b", exact: true }));
		await userEvent.click(screen.getByRole("button", { name: "Save button", exact: true }));
		const expected = [
			{ type: "form_submit", block_id: "a", values: { summary: "same" } },
			{ type: "form_submit", block_id: "b", values: { summary: "same" } },
			{ type: "form_submit", block_id: "b", values: { summary: "changed" } },
			{ type: "block_action" },
		];
		for (const [index, request] of requests.entries()) {
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(index + 2));
			expect(requestBody(fetchMock, index + 1)).toMatchObject(expected[index]);
			request.resolve(Response.json({ data: { blocks } }));
		}
		await expect.element(screen.getByRole("status")).toHaveTextContent("");
	});

	it.each(["fetch", "json"] as const)(
		"aborts a stale refresh during %s without reordering queued actions",
		async (phase) => {
			const staleFetch = Promise.withResolvers<Response>();
			const staleBody = Promise.withResolvers<unknown>();
			const staleResponse = Response.json({ data: { blocks: [] } });
			const json = vi.spyOn(staleResponse, "json").mockReturnValue(staleBody.promise);
			const action = Promise.withResolvers<Response>();
			const latest = Promise.withResolvers<Response>();
			const onEntryRefresh = vi.fn();
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(Response.json({ data: { blocks: editableBlocks } }))
				.mockReturnValueOnce(
					phase === "fetch" ? staleFetch.promise : Promise.resolve(staleResponse),
				)
				.mockReturnValueOnce(action.promise)
				.mockReturnValueOnce(latest.promise);
			vi.stubGlobal("fetch", fetchMock);
			const panel = (versionToken: string) => (
				<SandboxedContentEditorPanel
					pluginId="content-guard"
					panelId="findings"
					title="Findings"
					collection="posts"
					entryId="post-1"
					versionToken={versionToken}
					onEntryRefresh={onEntryRefresh}
				/>
			);
			const screen = await render(panel("v1"), { wrapper: Wrapper });
			await userEvent.click(screen.getByRole("button", { name: "Findings" }));
			await expect.element(screen.getByRole("button", { name: "Analyze" })).toBeVisible();
			await screen.rerender(panel("v2"));
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
			if (phase === "json") await vi.waitFor(() => expect(json).toHaveBeenCalledOnce());
			await userEvent.click(screen.getByRole("button", { name: "Analyze" }));
			await screen.rerender(panel("v3"));
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
			expect(fetchMock.mock.calls[1]?.[1]?.signal?.aborted).toBe(true);
			expect(requestBody(fetchMock, 2)).toMatchObject({
				type: "block_action",
				action_id: "analyze",
			});
			action.resolve(Response.json({ data: { blocks: editableBlocks } }));
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
			expect(requestBody(fetchMock, 3)).toEqual({ type: "panel_load" });
			await expect.element(screen.getByRole("status")).toHaveTextContent("");
			const staleData = {
				data: { blocks: [{ type: "header", text: "Stale findings" }], refresh: true },
			};
			staleFetch.resolve(Response.json(staleData));
			staleBody.resolve(staleData);
			await new Promise((resolve) => setTimeout(resolve, 50));
			expect(onEntryRefresh).not.toHaveBeenCalled();
			await expect.element(screen.getByRole("heading", { name: "Saved findings" })).toBeVisible();
			latest.resolve(
				Response.json({ data: { blocks: [{ type: "header", text: "Latest findings" }] } }),
			);
			await expect.element(screen.getByRole("heading", { name: "Latest findings" })).toBeVisible();
		},
	);

	it.each(["title", "description"] as const)(
		"queues an identical draft-aware action after editing the entry %s",
		async (field) => {
			const blocks: Block[] = [
				{
					type: "actions",
					elements: [{ type: "button", action_id: "translate", label: "Translate" }],
				},
			];
			const first = Promise.withResolvers<Response>();
			const second = Promise.withResolvers<Response>();
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(Response.json({ data: { blocks } }))
				.mockReturnValueOnce(first.promise)
				.mockReturnValueOnce(second.promise);
			vi.stubGlobal("fetch", fetchMock);
			function Editor() {
				const [entry, setEntry] = React.useState({
					title: "Original title",
					description: "Original description",
				});
				const editorGeneration = React.useRef(1);
				const entryRef = React.useRef(entry);
				entryRef.current = entry;
				return (
					<>
						{(["title", "description"] as const).map((name) => (
							<Input
								key={name}
								label={`Entry ${name}`}
								value={entry[name]}
								onChange={(event) => {
									editorGeneration.current++;
									setEntry({ ...entry, [name]: event.target.value });
								}}
							/>
						))}
						<SandboxedContentEditorPanel
							pluginId="translator"
							panelId="translation"
							title="Translation"
							collection="posts"
							entryId="post-1"
							draftAccess={{ read: { fields: ["title"] }, patch: { fields: ["title"] } }}
							captureDraft={() => ({
								collection: "posts",
								entryId: "post-1",
								locale: "en",
								baseRevision: "rev-1",
								generation: editorGeneration.current,
								invocationId: crypto.randomUUID(),
								fields: { title: entryRef.current.title },
							})}
						/>
					</>
				);
			}
			const screen = await render(<Editor />, { wrapper: Wrapper });
			await userEvent.click(screen.getByRole("button", { name: "Translation" }));
			const translate = screen.getByRole("button", { name: "Translate", exact: true });
			await userEvent.click(translate);
			await userEvent.click(translate);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			const original = requestBody(fetchMock, 1);
			expect(original).toMatchObject({
				type: "block_action",
				action_id: "translate",
				draft: { generation: 1, fields: { title: "Original title" } },
			});
			await screen.getByRole("textbox", { name: `Entry ${field}` }).fill("Edited entry");
			await userEvent.click(translate);
			await userEvent.click(translate);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			await screen.getByRole("textbox", { name: `Entry ${field}` }).fill("Latest entry");
			first.resolve(Response.json({ data: { blocks } }));
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
			const updated = requestBody(fetchMock, 2);
			expect(updated).toMatchObject({
				type: "block_action",
				action_id: "translate",
				draft: { fields: { title: field === "title" ? "Latest entry" : "Original title" } },
			});
			expect(updated.draft.generation).toBeGreaterThan(original.draft.generation);
			expect(updated.draft.invocationId).not.toBe(original.draft.invocationId);
			expect(fetchMock.mock.calls[1]?.[1]?.signal?.aborted).toBe(false);
			await userEvent.click(translate);
			second.resolve(Response.json({ data: { blocks } }));
			await expect.element(screen.getByRole("status")).toHaveTextContent("");
			expect(fetchMock).toHaveBeenCalledTimes(3);
		},
	);

	it.each(["missing", "null"] as const)(
		"does not suppress draft-aware actions when their editor draft identity is %s",
		async (identity) => {
			const blocks: Block[] = [
				{
					type: "actions",
					elements: [{ type: "button", action_id: "translate", label: "Translate" }],
				},
			];
			const pending = Promise.withResolvers<Response>();
			const fetchMock = vi
				.fn<typeof fetch>()
				.mockResolvedValueOnce(Response.json({ data: { blocks } }))
				.mockReturnValueOnce(pending.promise)
				.mockResolvedValueOnce(Response.json({ data: { blocks } }));
			vi.stubGlobal("fetch", fetchMock);
			const screen = await render(
				<SandboxedContentEditorPanel
					pluginId="translator"
					panelId="translation"
					title="Translation"
					collection="posts"
					entryId="post-1"
					draftAccess={{ read: { fields: ["title"] } }}
					captureDraft={identity === "missing" ? undefined : () => null}
				/>,
				{ wrapper: Wrapper },
			);
			await userEvent.click(screen.getByRole("button", { name: "Translation" }));
			const translate = screen.getByRole("button", { name: "Translate", exact: true });
			await userEvent.click(translate);
			await userEvent.click(translate);
			expect(fetchMock).toHaveBeenCalledTimes(2);
			pending.resolve(Response.json({ data: { blocks } }));
			await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
			expect(requestBody(fetchMock, 2)).toMatchObject({
				type: "block_action",
				action_id: "translate",
			});
			await expect.element(screen.getByRole("status")).toHaveTextContent("");
		},
	);

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
		expect(captureDraft).toHaveBeenCalledTimes(2);
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

	it("immediately replaces a stale panel load when the saved version changes during the initial load", async () => {
		const first = Promise.withResolvers<Response>();
		const second = Promise.withResolvers<Response>();
		const fetchMock = vi
			.fn<typeof fetch>()
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
		expect(fetchMock.mock.calls[0]?.[1]?.signal?.aborted).toBe(true);
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
