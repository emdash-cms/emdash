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
	it("counts the chosen options and adds or removes one", async () => {
		const onChange = vi.fn();
		const screen = await render(
			<CalendarFilters
				display={display}
				collections={collections}
				locales={["en"]}
				value={{ collections: ["posts"], locales: [], states: ["published", "overdue"] }}
				onChange={onChange}
			/>,
		);

		await screen.getByRole("button", { name: "Filter: 3 selected" }).click();
		await expect
			.element(screen.getByRole("menuitemcheckbox", { name: "Posts" }))
			.toHaveAttribute("aria-checked", "true");
		expect(screen.getByRole("menuitemcheckbox", { name: "English" }).query()).toBeNull();

		await screen.getByRole("menuitemcheckbox", { name: "Pages" }).click();
		expect(onChange).toHaveBeenLastCalledWith({ collections: ["posts", "pages"] });

		await screen.getByRole("menuitemcheckbox", { name: "Posts" }).click();
		expect(onChange).toHaveBeenLastCalledWith({ collections: [] });
	});

	it("filters by locale on multilingual sites and clears every filter", async () => {
		const onChange = vi.fn();
		const screen = await render(
			<CalendarFilters
				display={display}
				collections={collections}
				locales={["en", "fr"]}
				value={{ collections: [], locales: ["fr"], states: [] }}
				onChange={onChange}
			/>,
		);

		await screen.getByRole("button", { name: "Filter: 1 selected" }).click();
		await screen.getByRole("menuitemcheckbox", { name: "English" }).click();
		expect(onChange).toHaveBeenLastCalledWith({ locales: ["en", "fr"] });

		await screen.getByRole("menuitemcheckbox", { name: "Overdue" }).click();
		expect(onChange).toHaveBeenLastCalledWith({ states: ["overdue"] });

		await screen.getByRole("menuitem", { name: "Clear filters" }).click();
		expect(onChange).toHaveBeenLastCalledWith({ collections: [], locales: [], states: [] });
	});
});
