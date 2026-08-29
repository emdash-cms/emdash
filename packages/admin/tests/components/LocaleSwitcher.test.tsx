import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { LocaleSwitcher } from "../../src/components/LocaleSwitcher.js";
import { render } from "../utils/render.tsx";

describe("LocaleSwitcher", () => {
	it("opens an application-rendered locale menu that follows the active theme", async () => {
		const previousMode = document.documentElement.getAttribute("data-mode");
		document.documentElement.setAttribute("data-mode", "dark");

		try {
			const onChange = vi.fn();
			const screen = await render(
				<LocaleSwitcher locales={["en", "fr"]} defaultLocale="en" value="en" onChange={onChange} />,
			);

			const localeSwitcher = screen.getByRole("combobox", { name: "Locale" });
			await expect.element(localeSwitcher).toHaveTextContent(/^EN \(default\)$/);
			await userEvent.click(localeSwitcher);

			await expect.element(screen.getByRole("listbox")).toBeInTheDocument();
			await expect.element(screen.getByRole("option", { name: "EN (default)" })).toBeVisible();
			await userEvent.click(screen.getByRole("option", { name: "FR" }));
			expect(onChange).toHaveBeenCalledWith("fr");
		} finally {
			if (previousMode) {
				document.documentElement.setAttribute("data-mode", previousMode);
			} else {
				document.documentElement.removeAttribute("data-mode");
			}
		}
	});
});
