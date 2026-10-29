import { Input } from "@cloudflare/kumo";
import { describe, expect, it } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { HelpLabel, HelpTooltip } from "../../src/components/FieldHelpLabel.js";
import { render } from "../utils/render.tsx";

const HELP = "Slugs cannot be changed after the field is created.";

async function tap(element: Element) {
	const session = cdp();
	// Touch input lands in the top-level page, which hosts this test's frame.
	const frame = window.frameElement?.getBoundingClientRect() ?? new DOMRect();
	const scale = frame.width ? frame.width / window.innerWidth : 1;
	const box = element.getBoundingClientRect();
	const x = frame.left + (box.left + box.width / 2) * scale;
	const y = frame.top + (box.top + box.height / 2) * scale;
	await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
	await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
	await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
}

describe("HelpTooltip", () => {
	it("stays open after a tap, and the next tap closes it", async () => {
		const screen = await render(
			<HelpTooltip help={HELP} ariaLabel="More information about Slug" />,
		);
		const button = screen.getByRole("button", { name: "More information about Slug" });

		await tap(button.element());
		await new Promise((resolve) => setTimeout(resolve, 300));
		await expect.element(page.getByText(HELP)).toBeVisible();

		await tap(button.element());
		await expect.element(page.getByText(HELP)).not.toBeInTheDocument();
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
		await expect.element(page.getByText(HELP)).toBeVisible();

		await button.click();
		await expect.element(page.getByText(HELP)).not.toBeInTheDocument();
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
		await expect.element(page.getByText(HELP)).toBeVisible();

		await userEvent.keyboard("{Tab}");
		await expect.element(page.getByText(HELP)).not.toBeInTheDocument();
	});

	it("opens on hover", async () => {
		const screen = await render(
			<HelpTooltip help={HELP} ariaLabel="More information about Slug" />,
		);

		await screen.getByRole("button", { name: "More information about Slug" }).hover();

		await expect.element(page.getByText(HELP)).toBeVisible();
	});

	it("opens when it takes keyboard focus", async () => {
		await render(<HelpTooltip help={HELP} ariaLabel="More information about Slug" />);

		await userEvent.keyboard("{Tab}");

		await expect.element(page.getByText(HELP)).toBeVisible();
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
