import { describe, expect, it, vi } from "vitest";

import { CalendarFilters } from "../../../src/components/calendar/CalendarFilters";
import { createCalendarDisplay } from "../../../src/lib/calendar";
import { render } from "../../utils/render.tsx";

const collections = [
	{ slug: "posts", label: "Posts" },
	{ slug: "pages", label: "Pages" },
];
const display = createCalendarDisplay({
	locale: "en",
	timeZone: "UTC",
	viewerTimeZone: "UTC",
	collections,
	showLocale: true,
});

describe("CalendarFilters", () => {
	it("summarizes each filter and adds or removes the chosen option", async () => {
		const onChange = vi.fn();
		const screen = await render(
			<CalendarFilters
				display={display}
				collections={collections}
				locales={["en", "fr"]}
				value={{ collections: ["posts"], locales: [], states: ["published", "overdue"] }}
				onChange={onChange}
			/>,
		);

		await expect.element(screen.getByRole("button", { name: "Locale: All locales" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "State: 2 states" })).toBeVisible();

		await screen.getByRole("button", { name: "Collection: Posts" }).click();
		await screen.getByRole("menuitemcheckbox", { name: "Pages" }).click();
		expect(onChange).toHaveBeenLastCalledWith({ collections: ["posts", "pages"] });

		await screen.getByRole("menuitemcheckbox", { name: "Posts" }).click();
		expect(onChange).toHaveBeenLastCalledWith({ collections: [] });
	});
});
