import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import "../../../dist/styles.css";
import { EditMenuItemDialog } from "../../../src/components/menus/EditMenuItemDialog";
import type { MenuItem } from "../../../src/lib/api";
import { render } from "../../utils/render.tsx";

vi.mock("../../../src/lib/api", async () => {
	const actual = await vi.importActual("../../../src/lib/api");
	return {
		...actual,
		updateMenuItem: vi.fn().mockResolvedValue({}),
		fetchManifest: vi.fn().mockResolvedValue({ collections: {} }),
		fetchTaxonomyDefs: vi.fn().mockResolvedValue([]),
		fetchTerms: vi.fn().mockResolvedValue([]),
		fetchContent: vi.fn().mockRejectedValue(new Error("Not found")),
		fetchTrashedContent: vi.fn().mockResolvedValue({ items: [] }),
	};
});

import * as api from "../../../src/lib/api";

const BAD_URL = "Enter a URL that starts with https://, http://, mailto:, tel:, /, or #.";

const link: MenuItem = {
	id: "1",
	menuId: "menu1",
	parentId: null,
	sortOrder: 0,
	type: "custom",
	referenceCollection: null,
	referenceId: null,
	customUrl: "/about",
	label: "About",
	titleAttr: null,
	target: "_self",
	cssClasses: null,
	createdAt: "",
	locale: "en",
	translationGroup: "1",
};

const heading: MenuItem = { ...link, id: "2", customUrl: "#", label: "Resources" };

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

async function renderDialog(item: MenuItem) {
	const onClose = vi.fn();
	const screen = await render(
		<EditMenuItemDialog item={item} menuName="main-menu" menuLocale="en" onClose={onClose} />,
		{ wrapper: Wrapper },
	);
	const dialog = screen.getByRole("dialog", { name: "Edit menu item" });
	await expect.element(dialog).toBeVisible();
	return { dialog, onClose };
}

describe("EditMenuItemDialog", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("turns a heading into a link when a URL is entered", async () => {
		const { dialog, onClose } = await renderDialog(heading);

		const url = dialog.getByRole("textbox", { name: "URL" });
		await expect.element(url).toHaveValue("");
		await url.fill(" /resources ");
		await dialog.getByRole("button", { name: "Save" }).click();

		await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
		expect(api.updateMenuItem).toHaveBeenCalledWith(
			"main-menu",
			"2",
			expect.objectContaining({ customUrl: "/resources" }),
			{ locale: "en" },
		);
	});

	it("keeps a heading a heading when its URL is left empty", async () => {
		const { dialog, onClose } = await renderDialog(heading);

		await dialog.getByRole("textbox", { name: "Label", exact: true }).fill("Guides");
		await dialog.getByRole("button", { name: "Save" }).click();

		await vi.waitFor(() => expect(onClose).toHaveBeenCalled());
		const input = vi.mocked(api.updateMenuItem).mock.calls[0]![2];
		expect(input.label).toBe("Guides");
		expect(input.customUrl).toBeUndefined();
	});

	it("refuses an unsafe URL on a heading", async () => {
		const { dialog } = await renderDialog(heading);

		const url = dialog.getByRole("textbox", { name: "URL" });
		await url.fill("javascript:alert(1)");
		await dialog.getByRole("button", { name: "Save" }).click();

		await expect.element(dialog.getByText(BAD_URL)).toBeVisible();
		await expect.element(url).toHaveAttribute("aria-invalid", "true");
		expect(api.updateMenuItem).not.toHaveBeenCalled();
	});

	it("still requires a URL on a link", async () => {
		const { dialog } = await renderDialog(link);

		const url = dialog.getByRole("textbox", { name: "URL", exact: true });
		await url.fill("");
		await dialog.getByRole("button", { name: "Save" }).click();

		await expect.element(dialog.getByText("Enter a URL.")).toBeVisible();
		await expect.element(url).toHaveAttribute("aria-invalid", "true");
		expect(api.updateMenuItem).not.toHaveBeenCalled();
	});
});
