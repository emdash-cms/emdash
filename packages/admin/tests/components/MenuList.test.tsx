import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { MenuList } from "../../src/components/MenuList";
import { render } from "../utils/render.tsx";

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
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchMenus: vi.fn(),
		createMenu: vi.fn().mockResolvedValue({ name: "new-menu", label: "New Menu" }),
		deleteMenu: vi.fn().mockResolvedValue(undefined),
	};
});

import * as api from "../../src/lib/api";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DELETE_MENU_CONFIRMATION_REGEX = /Are you sure you want to delete this menu/;
const CREATE_MENU_REGEX = /Create Menu/;

function mockMenus() {
	vi.mocked(api.fetchMenus).mockResolvedValue([
		{
			id: "m1",
			name: "main",
			label: "Main Menu",
			itemCount: 3,
			created_at: "",
			updated_at: "",
		},
		{
			id: "m2",
			name: "footer",
			label: "Footer Menu",
			itemCount: 1,
			created_at: "",
			updated_at: "",
		},
	]);
}

function Wrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return (
		<Toasty>
			<QueryClientProvider client={qc}>{children}</QueryClientProvider>
		</Toasty>
	);
}

describe("MenuList", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockMenus();
	});

	it("displays list of menus with labels and item counts", async () => {
		const screen = await render(<MenuList />, { wrapper: Wrapper });

		const main = screen.getByRole("listitem").filter({ hasText: "Main Menu" });
		const footer = screen.getByRole("listitem").filter({ hasText: "Footer Menu" });
		await expect.element(main.getByRole("heading", { name: "Main Menu" })).toBeInTheDocument();
		await expect.element(main.getByText("main", { exact: true })).toBeInTheDocument();
		await expect.element(main.getByText("3 items")).toBeInTheDocument();
		await expect.element(footer.getByRole("heading", { name: "Footer Menu" })).toBeInTheDocument();
		await expect.element(footer.getByText("footer", { exact: true })).toBeInTheDocument();
		await expect.element(footer.getByText("1 item")).toBeInTheDocument();
	});

	it("Create Menu button opens dialog", async () => {
		const screen = await render(<MenuList />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: CREATE_MENU_REGEX }).click();
		await expect.element(screen.getByRole("heading", { name: "Create menu" })).toBeInTheDocument();
	});

	it("create dialog has name and label inputs", async () => {
		const screen = await render(<MenuList />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: CREATE_MENU_REGEX }).click();

		await expect.element(screen.getByLabelText("Name")).toBeInTheDocument();
		await expect.element(screen.getByLabelText("Label")).toBeInTheDocument();
	});

	it("clears a failed creation error after canceling", async () => {
		vi.mocked(api.createMenu).mockRejectedValueOnce(new Error("Name already in use"));
		const screen = await render(<MenuList />, { wrapper: Wrapper });

		await screen.getByRole("button", { name: CREATE_MENU_REGEX }).click();
		await screen.getByLabelText("Label").fill("Duplicate menu");
		await screen.getByLabelText("Name").fill("duplicate");
		screen.getByRole("button", { name: "Create", exact: true }).element().click();
		await expect.element(screen.getByRole("alert")).toHaveTextContent("Name already in use");

		screen.getByRole("button", { name: "Cancel" }).element().click();
		await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
		await screen.getByRole("button", { name: CREATE_MENU_REGEX }).click();
		await expect.element(screen.getByRole("alert")).not.toBeInTheDocument();
	});

	it.each(["Cancel", "Close"])(
		"keeps creation pending after %s and reopening",
		async (dismissButton) => {
			let resolveCreate!: (menu: Awaited<ReturnType<typeof api.createMenu>>) => void;
			vi.mocked(api.createMenu).mockImplementationOnce(
				() =>
					new Promise((resolve) => {
						resolveCreate = resolve;
					}),
			);
			const screen = await render(<MenuList />, { wrapper: Wrapper });

			await screen.getByRole("button", { name: CREATE_MENU_REGEX }).click();
			await screen.getByLabelText("Label").fill("Slow menu");
			await screen.getByLabelText("Name").fill("slow");
			screen.getByRole("button", { name: "Create", exact: true }).element().click();
			await expect.element(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();

			screen.getByRole("button", { name: dismissButton, exact: true }).element().click();
			await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
			await screen.getByRole("button", { name: CREATE_MENU_REGEX }).click();
			await expect.element(screen.getByRole("button", { name: "Creating..." })).toBeDisabled();
			expect(api.createMenu).toHaveBeenCalledTimes(1);

			resolveCreate({
				id: "slow",
				name: "slow",
				label: "Slow menu",
				createdAt: "",
				updatedAt: "",
				locale: "en",
				translationGroup: null,
			});
			await expect.element(screen.getByRole("dialog")).not.toBeInTheDocument();
		},
	);

	it("delete button opens confirmation dialog", async () => {
		const screen = await render(<MenuList />, { wrapper: Wrapper });

		await expect.element(screen.getByRole("heading", { name: "Main Menu" })).toBeInTheDocument();

		await screen.getByRole("button", { name: "Delete main menu" }).click();

		await expect.element(screen.getByRole("heading", { name: "Delete menu" })).toBeInTheDocument();
		await expect.element(screen.getByText(DELETE_MENU_CONFIRMATION_REGEX)).toBeInTheDocument();
	});

	it("shows empty state when no menus", async () => {
		vi.mocked(api.fetchMenus).mockResolvedValue([]);

		const screen = await render(<MenuList />, { wrapper: Wrapper });

		await expect.element(screen.getByText("No menus yet")).toBeInTheDocument();
		await expect
			.element(screen.getByText("Create your first navigation menu to get started"))
			.toBeInTheDocument();
	});

	it("each menu has an Edit link", async () => {
		const screen = await render(<MenuList />, { wrapper: Wrapper });

		await expect.element(screen.getByRole("heading", { name: "Main Menu" })).toBeInTheDocument();

		const editLinks = screen.getByText("Edit");
		await expect.element(editLinks.first()).toBeInTheDocument();
	});
});
