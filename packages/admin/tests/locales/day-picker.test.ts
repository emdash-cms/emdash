import { enUS } from "react-day-picker/locale";
import { describe, expect, test } from "vitest";

import { SUPPORTED_LOCALES } from "../../src/locales/config.js";
import { getDayPickerLocale } from "../../src/locales/day-picker.js";

const nonEnglishLocales = SUPPORTED_LOCALES.filter(
	({ code }) => code !== "pseudo" && new Intl.Locale(code).language !== "en",
);

describe("getDayPickerLocale", () => {
	test.each(nonEnglishLocales)(
		"does not fall back to the English calendar for $code",
		({ code }) => {
			expect(getDayPickerLocale(code)).not.toBe(enUS);
		},
	);
});
