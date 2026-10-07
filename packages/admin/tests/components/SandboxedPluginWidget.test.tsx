import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { SandboxedPluginWidget } from "../../src/components/SandboxedPluginWidget.js";
import { render } from "../utils/render.js";

describe("SandboxedPluginWidget while an action is answered", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps the blocks and marks the widget busy until the plugin answers", async () => {
		const answer = Promise.withResolvers<Response>();
		const fetchMock = vi
			.fn<() => Promise<Response>>()
			.mockResolvedValueOnce(
				Response.json({
					data: {
						blocks: [
							{ type: "header", text: "Traffic" },
							{
								type: "actions",
								elements: [{ type: "button", action_id: "refresh", label: "Refresh" }],
							},
						],
					},
				}),
			)
			.mockReturnValueOnce(answer.promise);
		vi.stubGlobal("fetch", fetchMock);
		const screen = await render(<SandboxedPluginWidget pluginId="analytics" widgetId="traffic" />);

		await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await expect.element(screen.getByRole("status")).toHaveTextContent("Updating...");
		await expect.element(screen.getByRole("heading", { name: "Traffic" })).toBeVisible();
		expect(screen.container.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(screen.container.querySelector('[aria-busy="true"] [role="status"]')).toBeNull();

		answer.resolve(Response.json({ data: { blocks: [{ type: "header", text: "Updated" }] } }));
		await expect.element(screen.getByRole("heading", { name: "Updated" })).toBeVisible();
		await expect.element(screen.getByRole("status")).toHaveTextContent("");
		expect(screen.container.querySelector('[aria-busy="true"]')).toBeNull();
	});

	it("stays busy when a superseded action is answered first", async () => {
		const first = Promise.withResolvers<Response>();
		const second = Promise.withResolvers<Response>();
		const fetchMock = vi
			.fn<() => Promise<Response>>()
			.mockResolvedValueOnce(
				Response.json({
					data: {
						blocks: [
							{
								type: "actions",
								elements: [{ type: "button", action_id: "refresh", label: "Refresh" }],
							},
						],
					},
				}),
			)
			.mockReturnValueOnce(first.promise)
			.mockReturnValueOnce(second.promise);
		vi.stubGlobal("fetch", fetchMock);
		const screen = await render(<SandboxedPluginWidget pluginId="analytics" widgetId="traffic" />);

		await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));

		first.resolve(Response.json({ data: { blocks: [{ type: "header", text: "Stale" }] } }));
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.getByRole("status").element().textContent).toBe("Updating...");
		expect(screen.container.querySelector('[aria-busy="true"]')).not.toBeNull();

		second.resolve(Response.json({ data: { blocks: [{ type: "header", text: "Updated" }] } }));
		await expect.element(screen.getByRole("heading", { name: "Updated" })).toBeVisible();
		await expect.element(screen.getByRole("status")).toHaveTextContent("");
	});
});
