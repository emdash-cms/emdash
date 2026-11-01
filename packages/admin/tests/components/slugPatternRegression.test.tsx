/**
 * Slug-style identifiers in the create dialogs take lowercase letters,
 * numbers, and hyphens. A hyphen has broken this check before (a `pattern`
 * attribute that browsers could not compile switched validation off), so each
 * dialog must still accept a hyphenated value and refuse anything else.
 */

import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import "../../dist/styles.css";
import { render } from "../utils/render.tsx";

// ---------------------------------------------------------------------------
// Router mock (shared across components under test)
// ---------------------------------------------------------------------------

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({
			children,
			to,
			...props
		}: {
			children: React.ReactNode;
			to?: string;
			[key: string]: unknown;
		}) => (
			<a href={typeof to === "string" ? to : "#"} {...props}>
				{children}
			</a>
		),
		useNavigate: () => vi.fn(),
		useParams: () => ({}),
		useSearch: () => ({}),
	};
});

// ---------------------------------------------------------------------------
// API mocks
// ---------------------------------------------------------------------------

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchSections: vi.fn().mockResolvedValue({ items: [] }),
		createSection: vi.fn(),
		deleteSection: vi.fn(),
		fetchMenus: vi.fn().mockResolvedValue([]),
		createMenu: vi.fn(),
		deleteMenu: vi.fn(),
		fetchWidgetAreas: vi.fn().mockResolvedValue([]),
		fetchWidgetComponents: vi.fn().mockResolvedValue([]),
		createWidgetArea: vi.fn(),
		deleteWidgetArea: vi.fn(),
		updateWidget: vi.fn(),
		deleteWidget: vi.fn(),
		reorderWidgets: vi.fn(),
	};
});

// Imported lazily so the mocks above are in place
const api = await import("../../src/lib/api");
const { Sections } = await import("../../src/components/Sections");
const { MenuList } = await import("../../src/components/MenuList");
const { Widgets } = await import("../../src/components/Widgets");

const SLUG_RULE = "Use lowercase letters, numbers, and hyphens.";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function Wrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return (
		<QueryClientProvider client={qc}>
			<Toasty>{children}</Toasty>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("slug-style identifiers accept hyphens and refuse other characters", () => {
	it("Sections create dialog", async () => {
		vi.mocked(api.createSection).mockResolvedValue({ slug: "hero-banner" } as Awaited<
			ReturnType<typeof api.createSection>
		>);
		const screen = await render(
			<Wrapper>
				<Sections />
			</Wrapper>,
		);
		await screen.getByText("New Section").click();
		const dialog = screen.getByRole("dialog", { name: "Create section" });
		await dialog.getByRole("textbox", { name: "Title", exact: true }).fill("Hero banner");
		const slug = dialog.getByRole("textbox", { name: "Slug", exact: true });

		await slug.fill("hero banner");
		await dialog.getByRole("button", { name: "Create section" }).click();
		await expect.element(dialog.getByText(SLUG_RULE)).toBeVisible();
		expect(api.createSection).not.toHaveBeenCalled();

		await slug.fill("hero-banner");
		await dialog.getByRole("button", { name: "Create section" }).click();
		await vi.waitFor(() =>
			expect(vi.mocked(api.createSection).mock.calls[0]?.[0]).toMatchObject({
				slug: "hero-banner",
			}),
		);
	});

	it("MenuList create dialog", async () => {
		vi.mocked(api.createMenu).mockResolvedValue({
			name: "footer-links",
			label: "Footer links",
		} as Awaited<ReturnType<typeof api.createMenu>>);
		const screen = await render(
			<Wrapper>
				<MenuList />
			</Wrapper>,
		);
		// With no menus, the header and the empty state both offer "Create Menu".
		await screen.getByText("Create Menu").first().click();
		const dialog = screen.getByRole("dialog", { name: "Create menu" });
		await dialog.getByRole("textbox", { name: "Label", exact: true }).fill("Footer links");
		const name = dialog.getByRole("textbox", { name: "Name", exact: true });

		await name.fill("footer_links");
		await dialog.getByRole("button", { name: "Create", exact: true }).click();
		await expect.element(dialog.getByText(SLUG_RULE)).toBeVisible();
		expect(api.createMenu).not.toHaveBeenCalled();

		await name.fill("footer-links");
		await dialog.getByRole("button", { name: "Create", exact: true }).click();
		await vi.waitFor(() =>
			expect(vi.mocked(api.createMenu).mock.calls[0]?.[0]).toMatchObject({
				name: "footer-links",
			}),
		);
	});

	it("Widgets create-area dialog", async () => {
		vi.mocked(api.createWidgetArea).mockResolvedValue({
			id: "a1",
			name: "main-sidebar",
			label: "Main sidebar",
		});
		const screen = await render(
			<Wrapper>
				<Widgets />
			</Wrapper>,
		);
		await screen.getByText("Add Widget Area").click();
		const dialog = screen.getByRole("dialog", { name: "Create Widget Area" });
		await dialog.getByRole("textbox", { name: "Label", exact: true }).fill("Main sidebar");
		const name = dialog.getByRole("textbox", { name: "Name", exact: true });

		await name.fill("Main Sidebar");
		await dialog.getByRole("button", { name: "Create", exact: true }).click();
		await expect.element(dialog.getByText(SLUG_RULE)).toBeVisible();
		expect(api.createWidgetArea).not.toHaveBeenCalled();

		await name.fill("main-sidebar");
		await dialog.getByRole("button", { name: "Create", exact: true }).click();
		await vi.waitFor(() =>
			expect(vi.mocked(api.createWidgetArea).mock.calls[0]?.[0]).toMatchObject({
				name: "main-sidebar",
			}),
		);
	});
});
