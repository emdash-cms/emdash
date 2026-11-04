import { Toast } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import type { BylineFieldDefinition } from "../../src/lib/api/byline-fields.js";
import { render } from "../utils/render.js";

vi.mock("../../src/lib/api/current-user", () => ({
	useCurrentUser: () => ({ data: { id: "u1", email: "a@a", role: 50 }, isLoading: false }),
}));

function makeField(overrides: Partial<BylineFieldDefinition>): BylineFieldDefinition {
	return {
		id: "fld_01",
		slug: "job_title",
		label: "Job title",
		type: "string",
		required: true,
		translatable: true,
		validation: null,
		sortOrder: 0,
		createdAt: "2026-01-01T00:00:00Z",
		updatedAt: "2026-01-01T00:00:00Z",
		...overrides,
	};
}

const fields = [
	makeField({}),
	makeField({
		id: "fld_02",
		slug: "mastodon_profile_handle_for_social_cards",
		label: "Mastodon profile handle",
		type: "url",
		required: false,
		translatable: false,
		sortOrder: 1,
	}),
];

vi.mock("../../src/lib/api/byline-fields", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/byline-fields")>(
		"../../src/lib/api/byline-fields",
	);
	return { ...actual, listBylineFields: vi.fn(async () => ({ items: fields })) };
});

const { BylineSchemaPage } = await import("../../src/routes/byline-schema");

function renderPage(width: number) {
	const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	return render(
		<div style={{ width }}>
			<QueryClientProvider client={queryClient}>
				<Toast.Provider>
					<BylineSchemaPage />
				</Toast.Provider>
			</QueryClientProvider>
		</div>,
	);
}

function expectInside(element: Element, box: DOMRect) {
	const bounds = element.getBoundingClientRect();
	expect(bounds.left).toBeGreaterThanOrEqual(box.left);
	expect(bounds.right).toBeLessThanOrEqual(box.right);
}

function visibleCount(elements: Element[]) {
	return elements.filter((element) => element.checkVisibility()).length;
}

describe("Byline fields table at phone width", () => {
	it("keeps the header's button on the page", async () => {
		const screen = await renderPage(272);
		const box = screen.container.firstElementChild!.getBoundingClientRect();
		const newField = screen.getByRole("button", { name: "New field" });

		await expect.element(newField).toBeVisible();
		expectInside(newField.element(), box);
	});

	it("keeps each field's slug, type, and actions in view", async () => {
		const screen = await renderPage(272);
		const label = screen.getByRole("button", { name: "Edit Mastodon profile handle" });
		await expect.element(label).toBeVisible();
		const table = screen.getByRole("table").element();
		const tray = table.parentElement!;
		const labelCell = page.elementLocator(label.element().closest("td")!);

		expect(tray.scrollWidth).toBeLessThanOrEqual(tray.clientWidth);
		await expect
			.element(labelCell.getByText("mastodon_profile_handle_for_social_cards"))
			.toBeVisible();
		await expect.element(labelCell.getByText("url", { exact: true })).toBeVisible();
		const actions = screen.getByRole("button", { name: /^Actions for / }).elements();
		expect(actions).toHaveLength(2);
		for (const button of actions) {
			expectInside(button, tray.getBoundingClientRect());
		}
	});
});

describe("Byline fields table at tablet width", () => {
	it("shows each field's slug and type once", async () => {
		const screen = await renderPage(716);
		await expect
			.element(screen.getByRole("button", { name: "Edit Mastodon profile handle" }))
			.toBeVisible();
		const tray = screen.getByRole("table").element().parentElement!;

		expect(tray.scrollWidth).toBeLessThanOrEqual(tray.clientWidth);
		expect(
			visibleCount(
				screen.getByText("mastodon_profile_handle_for_social_cards", { exact: true }).elements(),
			),
		).toBe(1);
		expect(visibleCount(screen.getByText("url", { exact: true }).elements())).toBe(1);
	});
});
