import { i18n } from "@lingui/core";
import { describe, it, expect, vi, afterEach } from "vitest";

import { cn, formatDate, formatDateTime, formatNumber, formatRelativeTime, slugify } from "../../src/lib/utils";

afterEach(() => {
	vi.useRealTimers();
	i18n.loadAndActivate({ locale: "en", messages: {} });
});

describe("slugify", () => {
	it("converts basic text to slug", () => {
		expect(slugify("Hello World")).toBe("hello-world");
	});

	it("handles unicode and diacritics", () => {
		expect(slugify("café résumé")).toBe("cafe-resume");
	});

	it("strips special characters", () => {
		expect(slugify("hello! @world# $")).toBe("hello-world");
	});

	it("collapses multiple hyphens", () => {
		expect(slugify("hello---world")).toBe("hello-world");
	});

	it("trims leading/trailing hyphens", () => {
		expect(slugify("-hello-world-")).toBe("hello-world");
	});

	it("handles underscores as separators", () => {
		expect(slugify("hello_world")).toBe("hello-world");
	});

	it("returns empty string for empty input", () => {
		expect(slugify("")).toBe("");
	});

	it("handles all special characters", () => {
		expect(slugify("!@#$%")).toBe("");
	});

	it("handles mixed case", () => {
		expect(slugify("HeLLo WoRLD")).toBe("hello-world");
	});

	it("handles multiple spaces", () => {
		expect(slugify("hello   world")).toBe("hello-world");
	});
});

describe("cn", () => {
	it("merges class names", () => {
		expect(cn("foo", "bar")).toBe("foo bar");
	});

	it("handles conditional classes", () => {
		const condition = false;
		expect(cn("foo", condition && "bar", "baz")).toBe("foo baz");
	});

	it("merges conflicting tailwind classes", () => {
		expect(cn("p-4", "p-2")).toBe("p-2");
	});

	it("handles undefined and null", () => {
		expect(cn("foo", undefined, null, "bar")).toBe("foo bar");
	});
});

describe("locale-aware formatting", () => {
	it("formats relative time using the active admin locale", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-06-03T12:00:00.000Z"));
		i18n.loadAndActivate({ locale: "id", messages: {} });

		expect(formatRelativeTime("2026-06-03T11:59:00.000Z")).toBe("1 menit yang lalu");
	});

	it("formats dates using the active admin locale", () => {
		i18n.loadAndActivate({ locale: "id", messages: {} });

		expect(formatDate("2026-06-03T12:00:00.000Z")).toBe(
			new Intl.DateTimeFormat("id").format(new Date("2026-06-03T12:00:00.000Z")),
		);
	});

	it("formats date-time values using the active admin locale", () => {
		i18n.loadAndActivate({ locale: "id", messages: {} });

		expect(formatDateTime("2026-06-03T12:34:00.000Z")).toBe(
			new Date("2026-06-03T12:34:00.000Z").toLocaleString("id"),
		);
	});

	it("formats numbers using the active admin locale", () => {
		i18n.loadAndActivate({ locale: "id", messages: {} });

		expect(formatNumber(1234567)).toBe(new Intl.NumberFormat("id").format(1234567));
	});
});
