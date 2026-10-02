import * as React from "react";
import { describe, expect, it } from "vitest";

import { ListPaginationFooter } from "../../src/components/ListPaginationFooter";
import { render } from "../utils/render.tsx";

const SEARCH_LOAD_MS = 50;

/**
 * A footer over three pages. A page request resolves at once, as a cached page
 * does, unless `pageLoadMs` is set. Typing in the search box starts a load the
 * footer didn't request.
 */
function Harness({ pageLoadMs }: { pageLoadMs?: number }) {
	const [page, setPage] = React.useState(1);
	const [isPending, setIsPending] = React.useState(false);
	const [loads, setLoads] = React.useState(0);
	const load = (ms: number) => {
		setIsPending(true);
		setTimeout(() => {
			setIsPending(false);
			setLoads((count) => count + 1);
		}, ms);
	};
	return (
		<>
			<input aria-label="Search" onChange={() => load(SEARCH_LOAD_MS)} />
			<output>{`Loads finished: ${loads}`}</output>
			<ListPaginationFooter
				label="Posts pagination"
				pageSizes={[20, 50]}
				pagination={{
					page,
					perPage: 20,
					totalCount: 60,
					isPending,
					onPageChange(nextPage) {
						setPage(nextPage);
						if (pageLoadMs !== undefined) load(pageLoadMs);
					},
					onPageSizeChange() {},
				}}
			/>
		</>
	);
}

async function settle() {
	await new Promise((resolve) => setTimeout(resolve, SEARCH_LOAD_MS));
}

describe("ListPaginationFooter", () => {
	it("returns focus to the control after the page it requested loads", async () => {
		const screen = await render(<Harness pageLoadMs={50} />);

		const nextPage = screen.getByRole("button", { name: "Next page" });
		await nextPage.click();

		await expect.element(screen.getByText("Loads finished: 1")).toBeInTheDocument();
		await expect.poll(() => document.activeElement).toBe(nextPage.element());
	});

	it("leaves focus alone after a load it didn't start", async () => {
		const screen = await render(<Harness />);

		await screen.getByRole("button", { name: "Next page" }).click();
		const search = screen.getByRole("textbox", { name: "Search" });
		await search.fill("d");

		await expect.element(screen.getByText("Loads finished: 1")).toBeInTheDocument();
		await settle();
		expect(document.activeElement).toBe(search.element());
	});

	it("leaves focus where it was moved while the requested page loads", async () => {
		const screen = await render(<Harness pageLoadMs={500} />);

		await screen.getByRole("button", { name: "Next page" }).click();
		const search = screen.getByRole("textbox", { name: "Search" });
		search.element().focus();

		await expect.element(screen.getByText("Loads finished: 1")).toBeInTheDocument();
		await settle();
		expect(document.activeElement).toBe(search.element());
	});
});
