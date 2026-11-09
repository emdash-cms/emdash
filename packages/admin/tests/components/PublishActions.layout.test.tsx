import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import { PublishActions } from "../../src/components/ContentSettingsPanel";
import { fetchRevisionEditors, type RevisionAuthor } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return { ...actual, fetchRevisionEditors: vi.fn() };
});

const EDITORS: Array<RevisionAuthor | null> = [
	{ id: "u-chris", name: "Christopher Montgomery-Smith of the Editorial Team" },
	{ id: "u-ana", name: "Ana Lima" },
	null,
];

describe("PublishActions layout", () => {
	beforeEach(() => {
		vi.resetAllMocks();
	});

	afterEach(async () => {
		await page.viewport(1280, 800);
	});

	it.each([
		["a wide screen", 1280],
		["a phone", 375],
	])(
		"keeps the confirmation's height when the names arrive and cuts a long line short, on %s",
		async (_name, width) => {
			await page.viewport(width, 800);
			let respond!: (editors: Array<RevisionAuthor | null>) => void;
			vi.mocked(fetchRevisionEditors).mockReturnValue(
				new Promise((resolve) => {
					respond = resolve;
				}),
			);
			const screen = await render(
				<PublishActions
					isLive
					hasPendingChanges
					onPublish={vi.fn()}
					revisions={{ collection: "posts", entryId: "item-1", liveRevisionId: "rev-1" }}
				/>,
			);
			await screen.getByRole("button", { name: "Publish changes", exact: true }).click();
			const dialog = screen.getByRole("dialog", { name: "Publish changes?" });
			await expect.element(dialog).toBeVisible();
			await vi.waitFor(() => expect(fetchRevisionEditors).toHaveBeenCalled());
			const loading = dialog.element().getBoundingClientRect().height;

			respond(EDITORS);
			const names = dialog.getByText("Edited by", { exact: false });
			await expect.element(names).toBeVisible();

			expect(dialog.element().getBoundingClientRect().height).toBe(loading);
			expect(names.element().scrollWidth).toBeGreaterThan(names.element().clientWidth);
		},
	);
});
