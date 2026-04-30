/**
 * Regression test for https://github.com/emdash-cms/emdash/issues/845
 *
 * Several admin forms use `<input pattern="...">` for slug-style identifiers.
 * Modern browsers compile that attribute as a regex with the `v`
 * (unicode-sets) flag, where unescaped/dangling `-` inside a character class
 * is a syntax error. The original `[a-z0-9-]+` therefore failed with
 * `Invalid character class` and disabled HTML form validation entirely on
 * the affected inputs.
 *
 * This test asserts that every slug-style `pattern` attribute in the admin
 * is a valid `v`-flag regex.
 */

import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

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
const { Sections } = await import("../../src/components/Sections");
const { MenuList } = await import("../../src/components/MenuList");
const { Widgets } = await import("../../src/components/Widgets");

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

/**
 * Asserts that every `<input pattern="...">` currently in the document is a
 * valid regex when compiled with the `v` flag — which is what the browser
 * does for HTML form validation.
 */
function expectAllPatternsValidV() {
	const inputs = [...document.querySelectorAll<HTMLInputElement>("input[pattern]")];
	expect(inputs.length).toBeGreaterThan(0);
	for (const input of inputs) {
		const pattern = input.getAttribute("pattern");
		expect(pattern, "input pattern attribute should be set").toBeTruthy();
		expect(
			() => new RegExp(pattern as string, "v"),
			`pattern ${JSON.stringify(pattern)} on input name=${JSON.stringify(input.name)} must compile with the 'v' flag`,
		).not.toThrow();
	}
}

beforeEach(() => {
	vi.clearAllMocks();
});

describe("slug pattern attributes are valid v-flag regexes (issue #845)", () => {
	it("Sections create dialog slug input pattern is valid", async () => {
		const screen = await render(
			<Wrapper>
				<Sections />
			</Wrapper>,
		);
		await screen.getByText("New Section").click();
		// Wait for the dialog to render
		await expect.element(screen.getByLabelText("Slug")).toBeInTheDocument();
		expectAllPatternsValidV();
	});

	it("MenuList create dialog name input pattern is valid", async () => {
		const screen = await render(
			<Wrapper>
				<MenuList />
			</Wrapper>,
		);
		// "Create Menu" button opens the create dialog. With empty menus, two
		// buttons render (header trigger + empty state CTA). Click the first.
		await screen.getByText("Create Menu").first().click();
		await expect.element(screen.getByLabelText("Name")).toBeInTheDocument();
		expectAllPatternsValidV();
	});

	it("Widgets create-area dialog name input pattern is valid", async () => {
		const screen = await render(
			<Wrapper>
				<Widgets />
			</Wrapper>,
		);
		await screen.getByText("Add Widget Area").click();
		await expect.element(screen.getByLabelText("Name")).toBeInTheDocument();
		expectAllPatternsValidV();
	});
});
