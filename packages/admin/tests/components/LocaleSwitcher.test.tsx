import { setupI18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { I18nProvider } from "@lingui/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { LocaleSwitcher } from "../../src/components/LocaleSwitcher.js";
// oxlint-disable-next-line import/no-unassigned-import -- Browser test verifies Kumo's computed theme surface.
import "@cloudflare/kumo/styles/standalone";

import { render } from "../utils/render.tsx";

const defaultLocaleIndicator = msg` (default)`;

function ControlledSwitcher({ initialValue = "en", showAll = false }) {
	const [value, setValue] = React.useState(initialValue);
	return (
		<LocaleSwitcher
			locales={["en", "fr"]}
			defaultLocale="en"
			value={value}
			onChange={setValue}
			showAll={showAll}
		/>
	);
}

describe("LocaleSwitcher", () => {
	it("opens the locale menu and displays the selected locale", async () => {
		const screen = await render(<ControlledSwitcher />);
		const localeSwitcher = screen.getByRole("combobox", { name: "Locale" });
		await expect.element(localeSwitcher).toHaveTextContent(/^EN \(default\)$/);
		await userEvent.click(localeSwitcher);

		await expect.element(screen.getByRole("option", { name: "EN (default)" })).toBeVisible();
		await expect
			.element(screen.getByRole("option", { name: "All locales" }))
			.not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("option", { name: "FR" }));
		await expect.element(localeSwitcher).toHaveTextContent(/^FR$/);
		await expect.element(screen.getByRole("listbox")).not.toBeInTheDocument();
	});

	it("displays all locales initially and after selecting it again", async () => {
		const screen = await render(<ControlledSwitcher initialValue="" showAll />);
		const localeSwitcher = screen.getByRole("combobox", { name: "Locale" });
		await expect.element(localeSwitcher).toHaveTextContent(/^All locales$/);

		await userEvent.click(localeSwitcher);
		await userEvent.click(screen.getByRole("option", { name: "EN (default)" }));
		await expect.element(localeSwitcher).toHaveTextContent(/^EN \(default\)$/);

		await userEvent.click(localeSwitcher);
		await userEvent.click(screen.getByRole("option", { name: "All locales" }));
		await expect.element(localeSwitcher).toHaveTextContent(/^All locales$/);
	});

	it("supports keyboard selection and cancels without changing the locale", async () => {
		const screen = await render(<ControlledSwitcher />);
		const localeSwitcher = screen.getByRole("combobox", { name: "Locale" });
		await userEvent.tab();
		await expect.element(localeSwitcher).toHaveFocus();
		await userEvent.keyboard("{Enter}{End}{Enter}");
		await expect.element(localeSwitcher).toHaveTextContent(/^FR$/);
		await expect.element(localeSwitcher).toHaveFocus();

		await userEvent.keyboard("{Enter}{Home}{Escape}");
		await expect.element(localeSwitcher).toHaveTextContent(/^FR$/);
		await expect.element(screen.getByRole("listbox")).not.toBeInTheDocument();
		await expect.element(localeSwitcher).toHaveFocus();
	});

	it("uses the existing translation for the default-locale indicator", async () => {
		const arabicI18n = setupI18n();
		arabicI18n.load("ar", { [defaultLocaleIndicator.id]: " الافتراضي" });
		arabicI18n.activate("ar");
		const screen = await render(<ControlledSwitcher />, {
			wrapper: ({ children }) => <I18nProvider i18n={arabicI18n}>{children}</I18nProvider>,
		});

		const localeSwitcher = screen.getByRole("combobox", { name: "Locale" });
		await expect.element(localeSwitcher).toHaveTextContent(/^EN الافتراضي$/);
		await userEvent.click(localeSwitcher);
		await expect.element(screen.getByRole("option", { name: "EN الافتراضي" })).toBeVisible();
	});

	it.each(["sm", "md"] as const)(
		"renders the open %s locale menu with the dark theme surface",
		async (size) => {
			const previousMode = document.documentElement.getAttribute("data-mode");
			const surfaceProbe = document.createElement("div");
			surfaceProbe.style.backgroundColor = "var(--color-kumo-base)";
			document.body.append(surfaceProbe);
			document.documentElement.setAttribute("data-mode", "dark");

			try {
				const screen = await render(
					<LocaleSwitcher
						locales={["en", "fr"]}
						defaultLocale="en"
						value="en"
						onChange={vi.fn()}
						size={size}
					/>,
				);

				await userEvent.click(screen.getByRole("combobox", { name: "Locale" }));
				const listbox = screen.getByRole("listbox");
				await expect.element(listbox).toBeVisible();
				const popup = listbox.element().parentElement;
				expect(popup).not.toBeNull();

				const darkSurface = getComputedStyle(surfaceProbe).backgroundColor;
				document.documentElement.setAttribute("data-mode", "light");
				const lightSurface = getComputedStyle(surfaceProbe).backgroundColor;
				document.documentElement.setAttribute("data-mode", "dark");

				expect(darkSurface).not.toBe(lightSurface);
				expect(getComputedStyle(popup!).backgroundColor).toBe(darkSurface);
			} finally {
				surfaceProbe.remove();
				if (previousMode) {
					document.documentElement.setAttribute("data-mode", previousMode);
				} else {
					document.documentElement.removeAttribute("data-mode");
				}
			}
		},
	);
});
