import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";

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

describe("plugin panel motion", () => {
	it.each([
		["desktop, reduced motion", 1280, 800, "ltr", "reduce"],
		["desktop, normal motion", 1280, 800, "ltr", "no-preference"],
		["phone RTL, reduced motion", 390, 844, "rtl", "reduce"],
		["phone RTL, normal motion", 390, 844, "rtl", "no-preference"],
	] as const)("respects the motion preference on %s", async (_, width, height, dir, motion) => {
		await page.viewport(width, height);
		await cdp().send("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-reduced-motion", value: motion }],
		});
		vi.stubGlobal(
			"fetch",
			vi.fn(async () =>
				Response.json({
					data: {
						blocks: [
							{ type: "header", text: "Saved findings" },
							{
								type: "form",
								fields: [{ type: "text_input", action_id: "summary", label: "Summary" }],
								submit: { label: "Save findings", action_id: "save" },
							},
						],
					},
				}),
			),
		);
		const screen = await render(
			<div dir={dir} className="mx-auto w-80 max-w-full p-4">
				<SandboxedContentEditorPanel
					pluginId="content-guard"
					panelId="findings"
					title="Findings"
					collection="posts"
					entryId="post-1"
				/>
			</div>,
			{ wrapper: Wrapper, container: adminRoot() },
		);
		const trigger = screen.getByRole("button", { name: "Findings", exact: true });
		async function toggleAndObserveHeightAnimations() {
			const animations = new Set<Animation>();
			trigger.element().click();
			const start = performance.now();
			await new Promise<void>((resolve) => {
				function sample() {
					const id = trigger.element().getAttribute("aria-controls");
					const panel = id ? document.getElementById(id) : null;
					for (const animation of panel?.getAnimations() ?? []) {
						if (animation instanceof CSSTransition && animation.transitionProperty === "height")
							animations.add(animation);
					}
					if (performance.now() - start < 250) requestAnimationFrame(sample);
					else resolve();
				}
				requestAnimationFrame(sample);
			});
			return animations.size;
		}
		const opening = await toggleAndObserveHeightAnimations();
		await expect.element(screen.getByRole("button", { name: "Save findings" })).toBeVisible();
		const closing = await toggleAndObserveHeightAnimations();
		await expect
			.element(screen.getByRole("button", { name: "Save findings" }))
			.not.toBeInTheDocument();
		if (motion === "reduce") expect({ opening, closing }).toEqual({ opening: 0, closing: 0 });
		else {
			expect(opening).toBeGreaterThan(0);
		}
	});
});
