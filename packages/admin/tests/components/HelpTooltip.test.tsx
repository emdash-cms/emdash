import { Input, Popover } from "@cloudflare/kumo";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { HelpLabel, HelpTooltip } from "../../src/components/FieldHelpLabel.js";
import { render } from "../utils/render.tsx";
import { tap } from "../utils/touch.ts";

const HELP = "Slugs cannot be changed after the field is created.";

describe("HelpTooltip", () => {
	it("stays open after a tap, and the next tap closes it", async () => {
		const screen = await render(
			<HelpTooltip help={HELP} ariaLabel="More information about Slug" />,
		);
		const button = screen.getByRole("button", { name: "More information about Slug" });

		await tap(button.element());
		await new Promise((resolve) => setTimeout(resolve, 300));
		await expect.element(page.getByRole("tooltip", { name: HELP })).toBeVisible();

		await tap(button.element());
		await expect.element(page.getByRole("tooltip", { name: HELP })).not.toBeInTheDocument();
	});

	it("stays open after a click until the next click", async () => {
		const screen = await render(
			<>
				<HelpTooltip help={HELP} ariaLabel="More information about Slug" />
				<p>Elsewhere</p>
			</>,
		);
		const button = screen.getByRole("button", { name: "More information about Slug" });

		await button.click();
		await screen.getByText("Elsewhere").hover();
		await expect.element(page.getByRole("tooltip", { name: HELP })).toBeVisible();

		await button.click();
		await expect.element(page.getByRole("tooltip", { name: HELP })).not.toBeInTheDocument();
	});

	it("closes when focus moves on after Enter pins it", async () => {
		await render(
			<>
				<HelpTooltip help={HELP} ariaLabel="More information about Slug" />
				<button type="button">Next</button>
			</>,
		);

		await userEvent.keyboard("{Tab}");
		await userEvent.keyboard("{Enter}");
		await expect.element(page.getByRole("tooltip", { name: HELP })).toBeVisible();

		await userEvent.keyboard("{Tab}");
		await expect.element(page.getByRole("tooltip", { name: HELP })).not.toBeInTheDocument();
	});

	it("stays open on a tap on the tooltip, which doesn't reach what it covers", async () => {
		const covered = vi.fn();
		const screen = await render(
			<div style={{ paddingTop: 96 }}>
				<button
					type="button"
					style={{ display: "block", width: 320, height: 64 }}
					onClick={covered}
				>
					Covered
				</button>
				<HelpTooltip help={HELP} ariaLabel="More information about Slug" />
			</div>,
		);
		await tap(screen.getByRole("button", { name: "More information about Slug" }).element());
		const help = page.getByRole("tooltip", { name: HELP });
		await expect.element(help).toBeVisible();
		const helpBox = help.element().getBoundingClientRect();
		const helpCenter = {
			x: helpBox.left + helpBox.width / 2,
			y: helpBox.top + helpBox.height / 2,
		};
		const coveredBox = screen
			.getByRole("button", { name: "Covered" })
			.element()
			.getBoundingClientRect();
		expect(document.elementFromPoint(helpCenter.x, helpCenter.y)).toBe(help.element());
		expect(helpCenter.y).toBeGreaterThan(coveredBox.top);
		expect(helpCenter.y).toBeLessThan(coveredBox.bottom);

		await tap(help.element());
		await new Promise((resolve) => setTimeout(resolve, 300));

		expect(covered).not.toHaveBeenCalled();
		await expect.element(help).toBeVisible();
	});

	it("closes a pinned tooltip on a tap elsewhere in a popover", async () => {
		const screen = await render(
			<Popover open>
				<Popover.Trigger asChild>
					<button type="button">Filter</button>
				</Popover.Trigger>
				<Popover.Content className="w-80 p-3">
					<input aria-label="Search" />
					<HelpTooltip help={HELP} ariaLabel="More information about Slug" />
					<p>Elsewhere in the popover</p>
				</Popover.Content>
			</Popover>,
		);
		const helpButton = screen.getByRole("button", { name: "More information about Slug" });
		await expect.element(helpButton).toBeVisible();
		const help = page.getByRole("tooltip", { name: HELP });
		// Like Safari, don't focus the tapped button, so focus leaving it can't close the help.
		const keepFocus = (event: MouseEvent) => {
			if (event.target instanceof Node && helpButton.element().contains(event.target)) {
				event.preventDefault();
			}
		};
		document.addEventListener("mousedown", keepFocus, true);
		try {
			await tap(helpButton.element());
			await expect.element(help).toBeVisible();
			expect(document.activeElement).not.toBe(helpButton.element());

			await tap(screen.getByText("Elsewhere in the popover").element());
			await expect.element(help).not.toBeInTheDocument();
		} finally {
			document.removeEventListener("mousedown", keepFocus, true);
		}
	});

	it("opens on hover", async () => {
		const screen = await render(
			<HelpTooltip help={HELP} ariaLabel="More information about Slug" />,
		);

		await screen.getByRole("button", { name: "More information about Slug" }).hover();

		await expect.element(page.getByRole("tooltip", { name: HELP })).toBeVisible();
	});

	it("opens when it takes keyboard focus", async () => {
		await render(<HelpTooltip help={HELP} ariaLabel="More information about Slug" />);

		await userEvent.keyboard("{Tab}");

		await expect.element(page.getByRole("tooltip", { name: HELP })).toBeVisible();
	});

	it("describes its button with the help", async () => {
		const screen = await render(
			<HelpTooltip help={HELP} ariaLabel="More information about Slug" />,
		);

		await expect
			.element(screen.getByRole("button", { name: "More information about Slug", exact: true }))
			.toHaveAccessibleDescription(HELP);
	});

	it("stays out of the name and label text of the field whose label holds it", async () => {
		const screen = await render(
			<Input label={<HelpLabel help={HELP}>Slug</HelpLabel>} aria-label="Slug" />,
		);

		await expect
			.element(screen.getByRole("textbox", { name: "Slug", exact: true }))
			.toBeInTheDocument();
		await expect.element(screen.getByLabelText("Slug", { exact: true })).toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "More information about Slug", exact: true }))
			.toBeInTheDocument();
	});
});
