import { setupI18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { I18nProvider } from "@lingui/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { LocaleSwitcher } from "../../src/components/LocaleSwitcher.js";
import { render } from "../utils/render.tsx";

const defaultLocaleIndicator = msg` (default)`;

describe("LocaleSwitcher", () => {
	it("uses the existing translation for the default-locale indicator", async () => {
		const arabicI18n = setupI18n();
		arabicI18n.load("ar", { [defaultLocaleIndicator.id]: " الافتراضي" });
		arabicI18n.activate("ar");
		const screen = await render(
			<LocaleSwitcher locales={["en", "fr"]} defaultLocale="en" value="en" onChange={vi.fn()} />,
			{
				wrapper: ({ children }) => <I18nProvider i18n={arabicI18n}>{children}</I18nProvider>,
			},
		);

		const localeSwitcher = screen.getByRole("combobox", { name: "Locale" });
		await expect.element(localeSwitcher).toHaveTextContent(/^EN الافتراضي$/);
		await userEvent.click(localeSwitcher);
		await expect.element(screen.getByRole("option", { name: "EN الافتراضي" })).toBeVisible();
	});

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
