import { i18n } from "@lingui/core";
import type { DayPickerLocale } from "react-day-picker/locale";
import { de } from "react-day-picker/locale/de";
import { enUS } from "react-day-picker/locale/en-US";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
	getLoadedDateLocale,
	loadDateLocale,
	useDateLocale,
	waitForDateLocale,
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

	describe("loading failures", () => {
		const testCodes: string[] = [];
		function addLocale(code: string, dateLocale: () => Promise<DayPickerLocale>) {
			LOCALES.push({ code, label: code, enabled: false, dateLocale });
			testCodes.push(code);
		}
		afterEach(() => {
			vi.useRealTimers();
			for (const code of testCodes.splice(0)) {
				LOCALES.splice(
					LOCALES.findIndex((locale) => locale.code === code),
					1,
				);
			}
		});

		test("falls back to US English once when a date locale fails to load", async () => {
			const loader = vi.fn(() => Promise.reject(new Error("chunk failed")));
			addLocale("x-failing", loader);

			expect(await loadDateLocale("x-failing")).toBe(enUS);
			expect(await loadDateLocale("x-failing")).toBe(enUS);
			expect(getLoadedDateLocale("x-failing")).toBe(enUS);
			expect(loader).toHaveBeenCalledTimes(1);
		});

		test("shares one load between concurrent callers", async () => {
			const loader = vi.fn(() => Promise.resolve(de));
			addLocale("x-shared", loader);

			const [first, second] = await Promise.all([
				loadDateLocale("x-shared"),
				loadDateLocale("x-shared"),
			]);
			expect(first).toBe(de);
			expect(second).toBe(de);
			expect(loader).toHaveBeenCalledTimes(1);
		});

		test("stops waiting after the timeout but keeps the late result", async () => {
			vi.useFakeTimers();
			let resolveLoad: (locale: DayPickerLocale) => void = () => {};
			addLocale(
				"x-slow",
				() =>
					new Promise((resolve) => {
						resolveLoad = resolve;
					}),
			);

			const waited = waitForDateLocale("x-slow", 1000);
			await vi.advanceTimersByTimeAsync(1000);
			await waited;
			expect(getLoadedDateLocale("x-slow")).toBeUndefined();

			resolveLoad(de);
			await vi.waitFor(() => expect(getLoadedDateLocale("x-slow")).toBe(de));
		});
	});
});
