import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { SandboxedPluginPage } from "../../src/components/SandboxedPluginPage.js";
import { resolvePluginLinkTarget } from "../../src/lib/plugin-links.js";
import { render } from "../utils/render.js";

describe("SandboxedPluginPage navigation", () => {
	beforeEach(() => {
		document.documentElement.dir = "rtl";
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					data: {
						blocks: [
							{ type: "header", text: "فحص المحتوى" },
							{
								type: "actions",
								elements: [
									{
										type: "link",
										label: "تحرير المقالة",
										target: {
											kind: "content",
											collection: "posts",
											id: "post-1",
											locale: "ar",
										},
										appearance: "primary",
									},
									{
										type: "link",
										label: "الوثائق",
										target: { kind: "external", url: "https://docs.example.test/plugin" },
									},
								],
							},
						],
					},
				}),
			),
		);
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		document.documentElement.dir = "ltr";
	});

	it("renders Kumo links with secure external attributes and RTL keyboard order", async () => {
		const screen = await render(<SandboxedPluginPage pluginId="content-guard" page="/overview" />);
		const internal = screen.getByRole("link", { name: "تحرير المقالة" });
		const external = screen.getByRole("link", { name: /الوثائق/ });
		await expect.element(internal).toBeVisible();
		await expect.element(external).toBeVisible();

		expect(internal.element().getAttribute("href")).toBe(
			"/_emdash/admin/content/posts/post-1?locale=ar",
		);
		expect(external.element().getAttribute("target")).toBe("_blank");
		expect(external.element().getAttribute("rel")).toBe("noopener noreferrer");

		await userEvent.tab();
		expect(document.activeElement).toBe(internal.element());
		await userEvent.tab();
		expect(document.activeElement).toBe(external.element());
		expect(getComputedStyle(internal.element()).direction).toBe("rtl");
	});

	it("identifies the declared page on follow-up actions", async () => {
		const fetchMock = vi.fn(async () =>
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
		);
		vi.stubGlobal("fetch", fetchMock);
		const screen = await render(<SandboxedPluginPage pluginId="content-guard" page="/overview" />);

		await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		const request = fetchMock.mock.calls[1]?.[1];
		expect(JSON.parse(String(request?.body))).toEqual({
			type: "block_action",
			action_id: "refresh",
			page: "/overview",
		});
	});

	it("ignores a stale response after navigating to another plugin page", async () => {
		const overview = Promise.withResolvers<Response>();
		const reports = Promise.withResolvers<Response>();
		vi.stubGlobal(
			"fetch",
			vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
				if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
				const interaction = JSON.parse(init.body) as { page: string };
				return interaction.page === "/overview" ? overview.promise : reports.promise;
			}),
		);
		const screen = await render(<SandboxedPluginPage pluginId="content-guard" page="/overview" />);
		await screen.rerender(<SandboxedPluginPage pluginId="content-guard" page="/reports" />);

		reports.resolve(
			Response.json({ data: { blocks: [{ type: "header", text: "Reports page" }] } }),
		);
		await expect.element(screen.getByRole("heading", { name: "Reports page" })).toBeVisible();

		overview.resolve(
			Response.json({ data: { blocks: [{ type: "header", text: "Overview page" }] } }),
		);
		await expect
			.element(screen.getByRole("heading", { name: "Overview page" }))
			.not.toBeInTheDocument();
		await expect.element(screen.getByRole("heading", { name: "Reports page" })).toBeVisible();
	});

	it("clears an earlier toast when the next interaction has none", async () => {
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
						toast: { type: "success", message: "First response" },
					},
				}),
			)
			.mockResolvedValueOnce(Response.json({ data: { blocks: [] } }));
		vi.stubGlobal("fetch", fetchMock);
		const screen = await render(<SandboxedPluginPage pluginId="content-guard" page="/overview" />);
		await expect.element(screen.getByText("First response", { exact: true })).toBeVisible();
		await userEvent.click(screen.getByRole("button", { name: "Refresh" }));
		await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
		await expect
			.element(screen.getByText("First response", { exact: true }))
			.not.toBeInTheDocument();
	});
});

describe("SandboxedPluginPage while an action is answered", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
	});

	it("keeps the blocks and marks the page busy until the plugin answers", async () => {
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
		const screen = await render(<SandboxedPluginPage pluginId="analytics" page="/analytics" />);

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
		const screen = await render(<SandboxedPluginPage pluginId="analytics" page="/analytics" />);

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

describe("resolvePluginLinkTarget", () => {
	it("constructs internal URLs and rejects traversal or active protocols", () => {
		expect(
			resolvePluginLinkTarget("content-guard", {
				kind: "plugin-page",
				path: "/reports",
			}),
		).toBe("/_emdash/admin/plugins/content-guard/reports");
		expect(
			resolvePluginLinkTarget("content-guard", {
				kind: "plugin-page",
				path: "reports",
			}),
		).toBe("/_emdash/admin/plugins/content-guard/reports");
		expect(
			resolvePluginLinkTarget("content-guard", {
				kind: "plugin-settings",
			}),
		).toBe("/_emdash/admin/plugins-manager/content-guard/settings");
		expect(
			resolvePluginLinkTarget("content-guard", {
				kind: "plugin-page",
				path: "/../settings",
			}),
		).toBeNull();
		expect(
			resolvePluginLinkTarget("content-guard", {
				kind: "plugin-page",
				path: "/%2e%2e/%2e%2e/settings",
			}),
		).toBeNull();
		expect(
			resolvePluginLinkTarget("content-guard", {
				kind: "external",
				url: "javascript:alert(1)",
			}),
		).toBeNull();
	});
});
