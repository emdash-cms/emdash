import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { fetchBylines } from "../../src/lib/api";
import { BylinesPage } from "../../src/routes/bylines";
import { render } from "../utils/render.tsx";
import { QueryWrapper } from "../utils/test-helpers.tsx";

// The bylines page reads the active locale from the URL and navigates on
// locale switches; neither matters for the search-debounce behaviour, so we
// stub the router hooks to a single-locale, no-op shape.
vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		useNavigate: () => vi.fn(),
		useSearch: () => ({}),
	};
});

// fetchManifest is imported from the client module directly.
vi.mock("../../src/lib/api/client.js", async () => {
	const actual = await vi.importActual("../../src/lib/api/client.js");
	return {
		...actual,
		fetchManifest: vi.fn().mockResolvedValue({}),
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchBylines: vi.fn(),
		fetchUsers: vi.fn().mockResolvedValue({ items: [] }),
		fetchByline: vi.fn().mockResolvedValue(null),
		fetchBylineTranslations: vi.fn().mockResolvedValue({ items: [] }),
	};
});

const fetchBylinesMock = vi.mocked(fetchBylines);

function searchArgs(): (string | undefined)[] {
	return fetchBylinesMock.mock.calls.map((call) => call[0]?.search);
}

describe("BylinesPage search", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		fetchBylinesMock.mockResolvedValue({ items: [], nextCursor: undefined });
	});

	it("debounces rapid typing into a single refetch and keeps the input mounted", async () => {
		vi.useFakeTimers();
		try {
			const screen = await render(
				<QueryWrapper>
					<BylinesPage />
				</QueryWrapper>,
			);

			// Let the initial bylines query resolve so the full-page loader
			// gate (isLoading && !data) clears and the list view renders.
			await vi.advanceTimersByTimeAsync(0);
			expect(searchArgs()).toEqual([undefined]);

			const input = screen.getByPlaceholder("Search bylines");
			await expect.element(input).toBeInTheDocument();

			// Three keystrokes in quick succession (under the 300ms window).
			await input.fill("a");
			await input.fill("al");
			await input.fill("ali");

			// No new fetch yet: the debounce has not elapsed, and the input
			// must stay mounted/focused rather than being unmounted by a
			// full-page loader takeover on every keystroke.
			expect(searchArgs()).toEqual([undefined]);
			await expect.element(input).toHaveValue("ali");

			// After the debounce window, exactly one additional refetch fires
			// for the final value — not one per intermediate keystroke.
			await vi.advanceTimersByTimeAsync(300);
			expect(searchArgs()).toEqual([undefined, "ali"]);

			// The list view (and its search input) is still mounted.
			await expect.element(screen.getByPlaceholder("Search bylines")).toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});
});
