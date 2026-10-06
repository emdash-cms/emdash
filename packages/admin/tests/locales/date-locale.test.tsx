import { i18n } from "@lingui/core";
import { enUS } from "react-day-picker/locale/en-US";
import { describe, expect, test } from "vitest";

import {
	getLoadedDateLocale,
	loadDateLocale,
	useDateLocale,
} from "../../src/locales/date-locale.js";
import { LOCALES } from "../../src/locales/locales.js";
import { render } from "../utils/render";

const nonEnglishLocales = LOCALES.filter(
	({ code }) => code !== "pseudo" && new Intl.Locale(code).language !== "en",
);

describe("date locales", () => {
	test.each(nonEnglishLocales)(
		"loads a date locale in the same language for $code",
		async ({ code }) => {
			const dateLocale = await loadDateLocale(code);

			expect(new Intl.Locale(dateLocale.code).language).toBe(new Intl.Locale(code).language);
		},
	);

	test("uses the US English calendar for English and unknown locales", async () => {
		expect(getLoadedDateLocale("en")).toBe(enUS);
		expect(await loadDateLocale("xx-unknown")).toBe(enUS);
	});

	test("makes a loaded date locale available synchronously", async () => {
		const dateLocale = await loadDateLocale("de");

		expect(getLoadedDateLocale("de")).toBe(dateLocale);
	});

	test("follows the active admin locale", async () => {
		const previousLocale = i18n.locale;
		function MonthName() {
			const dateLocale = useDateLocale();
			return <p>{dateLocale.localize.month(0)}</p>;
		}
		try {
			i18n.loadAndActivate({ locale: "en", messages: {} });
			const screen = await render(<MonthName />);
			await expect.element(screen.getByText("January")).toBeInTheDocument();

			i18n.loadAndActivate({ locale: "fr", messages: {} });
			await screen.rerender(<MonthName />);
			await expect.element(screen.getByText("janvier")).toBeInTheDocument();
		} finally {
			i18n.loadAndActivate({ locale: previousLocale, messages: {} });
		}
	});
});
