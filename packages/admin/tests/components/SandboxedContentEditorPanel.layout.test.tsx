import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { SandboxedContentEditorPanel } from "../../src/components/SandboxedContentEditorPanel.js";
import { adminRoot } from "../utils/form-layout.js";
import { render } from "../utils/render.js";

function Wrapper({ children }: React.PropsWithChildren) {
	return <Toasty>{children}</Toasty>;
}

afterEach(async () => {
	vi.unstubAllGlobals();
	await cdp().send("Emulation.setEmulatedMedia", { features: [] });
	await page.viewport(1280, 800);
});

describe("SandboxedContentEditorPanel layout", () => {
	it.each(
		(
			[
				["desktop", 1280, 800, "ltr", "no-preference"],
				["desktop with reduced motion", 1280, 800, "ltr", "reduce"],
				["phone RTL", 390, 844, "rtl", "no-preference"],
				["phone RTL with reduced motion", 390, 844, "rtl", "reduce"],
			] as const
		).flatMap(
			([label, width, height, dir, motion]) =>
				[
					[`${label}, response during opening`, width, height, dir, motion, true],
					[`${label}, response after opening`, width, height, dir, motion, false],
				] as const,
		),
	)(
		"fits asynchronous and conditional content on %s",
		async (_, width, height, dir, motion, earlyResponse) => {
			await cdp().send("Emulation.setEmulatedMedia", {
				features: [{ name: "prefers-reduced-motion", value: motion }],
			});
			await page.viewport(width, height);
			const response = Promise.withResolvers<Response>();
			const fetchMock = vi.fn(() => response.promise);
			vi.stubGlobal("fetch", fetchMock);
			const screen = await render(
				<div dir={dir} className="mx-auto w-80 max-w-full p-4">
					<SandboxedContentEditorPanel
						pluginId="content-guard"
						panelId="findings"
						title="Findings"
						collection="posts"
						entryId="post-1"
					/>
					<p className="mt-4">Next settings section</p>
				</div>,
				{ wrapper: Wrapper, container: adminRoot() },
			);
			const trigger = screen.getByRole("button", { name: "Findings", exact: true });
			function getPanel() {
				const panelId = trigger.element().getAttribute("aria-controls");
				const panel = panelId ? document.getElementById(panelId) : null;
				if (!panel) throw new Error("Plugin panel missing");
				return panel;
			}
			if (earlyResponse) {
				trigger.element().click();
			} else {
				await userEvent.click(trigger);
				await expect.element(screen.getByLabelText("Loading plugin panel")).toBeVisible();
				const panel = getPanel();
				// Let the disclosure finish while the network response remains pending.
				await vi.waitFor(() => {
					expect(panel.getAnimations()).toHaveLength(0);
					expect(panel.getBoundingClientRect().height).toBeCloseTo(
						panel.firstElementChild!.getBoundingClientRect().height,
						0,
					);
				});
			}
			response.resolve(
				Response.json({
					data: {
						blocks: [
							{ type: "header", text: "Saved findings" },
							{
								type: "form",
								fields: [
									{
										type: "toggle",
										action_id: "details",
										label: "Show details",
										initial_value: false,
									},
									{ type: "text_input", action_id: "summary", label: "Summary" },
									{
										type: "text_input",
										action_id: "notes",
										label: "Notes",
										condition: { field: "details", eq: true },
									},
									{
										type: "text_input",
										action_id: "recommendation",
										label: "Recommendation",
										condition: { field: "details", eq: true },
									},
								],
								submit: { label: "Save findings", action_id: "save" },
							},
						],
					},
				}),
			);
			await expect.element(screen.getByRole("button", { name: "Save findings" })).toBeVisible();
			const panel = getPanel();
			const nextSection = screen.getByText("Next settings section").element();
			async function expectContentFits() {
				await vi.waitFor(() => {
					const box = panel.getBoundingClientRect();
					const content = panel.firstElementChild!.getBoundingClientRect();
					expect(content.bottom).toBeLessThanOrEqual(box.bottom + 1);
					expect(box.height - content.height).toBeLessThanOrEqual(1);
					expect(nextSection.getBoundingClientRect().top).toBeGreaterThanOrEqual(content.bottom);
				});
			}
			if (!earlyResponse) await expectContentFits();
			const compactHeight = panel.firstElementChild!.getBoundingClientRect().height;
			const toggle = screen.getByRole("switch", { name: "Show details" });
			if (earlyResponse) toggle.element().click();
			else await userEvent.click(toggle);
			await expect.element(screen.getByRole("textbox", { name: "Recommendation" })).toBeVisible();
			await expectContentFits();
			expect(panel.getBoundingClientRect().height).toBeGreaterThan(compactHeight + 40);
			await userEvent.click(screen.getByRole("switch", { name: "Show details" }));
			await expect
				.element(screen.getByRole("textbox", { name: "Recommendation" }))
				.not.toBeInTheDocument();
			await expectContentFits();
			expect(panel.getBoundingClientRect().height).toBeCloseTo(compactHeight, 0);
			await userEvent.click(trigger);
			await expect
				.element(screen.getByRole("button", { name: "Save findings" }))
				.not.toBeInTheDocument();
			await userEvent.click(trigger);
			await expect.element(screen.getByRole("button", { name: "Save findings" })).toBeVisible();
			await expectContentFits();
			expect(fetchMock).toHaveBeenCalledTimes(1);
		},
	);
});
