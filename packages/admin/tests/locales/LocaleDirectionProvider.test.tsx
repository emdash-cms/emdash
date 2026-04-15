import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { LocaleDirectionProvider } from "../../src/locales/LocaleDirectionProvider.js";
import { useLocale } from "../../src/locales/useLocale.js";

const expectHTMLAttr = (attr: "lang" | "dir", expected: string | null) => {
	expect(document.documentElement.getAttribute(attr)).toBe(expected);
};

describe("LocaleDirectionProvider", () => {
	beforeEach(() => {
		document.documentElement.removeAttribute("dir");
		document.documentElement.removeAttribute("lang");
	});

	test("throws error when used without I18nProvider", () => {
		const consoleErrorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

		try {
			expect(() => {
				render(
					<LocaleDirectionProvider>
						<div>test</div>
					</LocaleDirectionProvider>,
				);
			}).toThrow();
		} finally {
			consoleErrorSpy.mockRestore();
		}
	});

	test("works correctly when wrapped by I18nProvider", () => {
		i18n.loadAndActivate({ locale: "en", messages: {} });

		expect(() => {
			render(
				<I18nProvider i18n={i18n}>
					<LocaleDirectionProvider>
						<div data-testid="content">test</div>
					</LocaleDirectionProvider>
				</I18nProvider>,
			);
		}).not.toThrow();

		expect(screen.getByTestId("content")).toBeInTheDocument();
	});

	test("updates document.documentElement.lang attribute and dir attribute for RTL locale", () => {
		i18n.loadAndActivate({ locale: "ar", messages: {} });

		render(
			<I18nProvider i18n={i18n}>
				<LocaleDirectionProvider>
					<div>test</div>
				</LocaleDirectionProvider>
			</I18nProvider>,
		);

		expectHTMLAttr("lang", "ar");
		expectHTMLAttr("dir", "rtl");
	});
	test("updates document.documentElement.lang and dir attributes when locale changes", async () => {
		i18n.loadAndActivate({ locale: "en", messages: {} });

		const LocaleButton = () => {
			const { setLocale } = useLocale();

			return (
				<button type="button" data-testid="locale-button" onClick={() => setLocale("ar")}>
					Dashing into Arabic
				</button>
			);
		};

		render(
			<I18nProvider i18n={i18n}>
				<LocaleDirectionProvider>
					<LocaleButton />
				</LocaleDirectionProvider>
			</I18nProvider>,
		);

		expectHTMLAttr("dir", "ltr");
		expectHTMLAttr("lang", "en");

		await userEvent.click(screen.getByTestId("locale-button"));

		await waitFor(() => {
			expectHTMLAttr("dir", "rtl");
			expectHTMLAttr("lang", "ar");
		});
	});
});
