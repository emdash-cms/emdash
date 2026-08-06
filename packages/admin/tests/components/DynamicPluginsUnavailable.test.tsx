import { describe, it, expect } from "vitest";

import { render } from "../utils/render.tsx";

const { DynamicPluginsUnavailable } =
	await import("../../src/components/DynamicPluginsUnavailable");

describe("DynamicPluginsUnavailable", () => {
	it("explains that dynamic plugins aren't available", async () => {
		const screen = await render(<DynamicPluginsUnavailable />);
		await expect
			.element(screen.getByText("Dynamic plugins aren't available on this deployment"))
			.toBeInTheDocument();
	});

	it("shows the worker_loaders binding to add", async () => {
		const screen = await render(<DynamicPluginsUnavailable />);
		await expect
			.element(screen.getByText('"worker_loaders": [{ "binding": "LOADER" }]'))
			.toBeInTheDocument();
	});

	it("links to the install docs", async () => {
		const screen = await render(<DynamicPluginsUnavailable />);
		const link = screen.getByRole("link", { name: /enable dynamic plugins/i });
		await expect
			.element(link)
			.toHaveAttribute("href", "https://docs.emdashcms.com/plugins/installing/");
	});
});
