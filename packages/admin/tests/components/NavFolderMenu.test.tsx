import { Sidebar } from "@cloudflare/kumo";
import { Calendar, Tag } from "@phosphor-icons/react";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { render } from "../utils/render.tsx";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, to, ...props }: any) => (
			<a href={to} {...props}>
				{children}
			</a>
		),
		useNavigate: () => vi.fn(),
	};
});

const { NavFolderMenu, useFolderState } = await import("../../src/components/Sidebar");
type NavItem = import("../../src/components/Sidebar").NavItem;

const STORAGE_KEY = "emdash-sidebar-folders";

const folder = {
	kind: "folder" as const,
	label: "Calendar",
	items: [
		{
			to: "/content/$collection",
			params: { collection: "events" },
			label: "Events",
			icon: Calendar,
		},
		{
			to: "/content/$collection",
			params: { collection: "venues" },
			label: "Venues",
			icon: Calendar,
		},
		{ to: "/taxonomies/$slug", params: { slug: "event-type" }, label: "Event types", icon: Tag },
	] satisfies NavItem[],
};

function mount(ui: React.ReactNode, { expanded = true } = {}) {
	return render(
		<Sidebar.Provider defaultOpen={expanded}>
			<Sidebar>
				<Sidebar.Content>
					<Sidebar.Menu>{ui}</Sidebar.Menu>
				</Sidebar.Content>
			</Sidebar>
		</Sidebar.Provider>,
	);
}

describe("NavFolderMenu", () => {
	it("keeps its members out of the accessibility tree while closed", async () => {
		const screen = await mount(
			<NavFolderMenu folder={folder} currentPath="/" open={false} onToggle={() => {}} />,
		);
		await expect
			.element(screen.getByRole("button", { name: /Calendar/ }))
			.toHaveAttribute("aria-expanded", "false");
		expect(screen.getByRole("link", { name: "Venues" }).query()).toBeNull();
	});

	it("links every member to its route while open", async () => {
		const screen = await mount(
			<NavFolderMenu folder={folder} currentPath="/" open onToggle={() => {}} />,
		);
		await expect
			.element(screen.getByRole("button", { name: /Calendar/ }))
			.toHaveAttribute("aria-expanded", "true");
		await expect
			.element(screen.getByRole("link", { name: "Venues" }))
			.toHaveAttribute("href", "/content/venues");
		await expect
			.element(screen.getByRole("link", { name: "Event types" }))
			.toHaveAttribute("href", "/taxonomies/event-type");
	});

	it("reports a click on the folder button", async () => {
		const onToggle = vi.fn();
		const screen = await mount(
			<NavFolderMenu folder={folder} currentPath="/" open onToggle={onToggle} />,
		);
		await screen.getByRole("button", { name: /Calendar/ }).click();
		expect(onToggle).toHaveBeenCalledTimes(1);
	});

	it("collapses to one link targeting the active member", async () => {
		const screen = await mount(
			<NavFolderMenu
				folder={folder}
				currentPath="/content/venues/abc"
				open={false}
				onToggle={() => {}}
			/>,
			{ expanded: false },
		);
		await expect
			.element(screen.getByRole("link", { name: /Calendar/ }))
			.toHaveAttribute("href", "/content/venues");
		expect(screen.container.querySelectorAll("a")).toHaveLength(1);
	});

	it("collapses to the first member when none is active", async () => {
		const screen = await mount(
			<NavFolderMenu folder={folder} currentPath="/media" open={false} onToggle={() => {}} />,
			{ expanded: false },
		);
		await expect
			.element(screen.getByRole("link", { name: /Calendar/ }))
			.toHaveAttribute("href", "/content/events");
	});
});

describe("useFolderState", () => {
	beforeEach(() => {
		localStorage.clear();
	});

	function Harness() {
		const folders = useFolderState();
		return (
			<button type="button" onClick={() => folders.setOpen("Calendar", false)}>
				{String(folders.state.Calendar ?? "unset")}
			</button>
		);
	}

	it("stores a choice next to the ones already saved", async () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ Shop: true, junk: "x" }));
		const screen = await render(<Harness />);
		await expect.element(screen.getByRole("button")).toHaveTextContent("unset");
		await screen.getByRole("button").click();
		await expect.element(screen.getByRole("button")).toHaveTextContent("false");
		expect(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")).toEqual({
			Shop: true,
			Calendar: false,
		});
	});

	it("starts from the stored choice", async () => {
		localStorage.setItem(STORAGE_KEY, JSON.stringify({ Calendar: false }));
		const screen = await render(<Harness />);
		await expect.element(screen.getByRole("button")).toHaveTextContent("false");
	});
});
