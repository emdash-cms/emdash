import { Button, Dialog, DropdownMenu } from "@cloudflare/kumo";
import * as React from "react";
import { beforeEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import { ConfirmDialog } from "../../src/components/ConfirmDialog.js";
import { DataTable, RowActionsMenu, RowTitleButton } from "../../src/components/DataTable.js";
import { render } from "../utils/render.tsx";

interface Person {
	name: string;
	pending?: boolean;
}

interface PeopleHandle {
	remove: (...names: string[]) => void;
	approve: (name: string) => void;
	prepend: (name: string) => void;
}

const PEOPLE: Person[] = [
	{ name: "Ada" },
	{ name: "Grace" },
	{ name: "Hedy" },
	{ name: "Katherine" },
];

function PeopleTable({
	initial = PEOPLE,
	handle,
}: {
	initial?: Person[];
	handle?: React.Ref<PeopleHandle>;
}) {
	const [people, setPeople] = React.useState(initial);
	const [search, setSearch] = React.useState("");
	const [deleting, setDeleting] = React.useState<string | null>(null);
	const [archiving, setArchiving] = React.useState<string | null>(null);
	const [details, setDetails] = React.useState<string | null>(null);
	const remove = (...names: string[]) =>
		setPeople((current) => current.filter((person) => !names.includes(person.name)));
	React.useImperativeHandle(handle, () => ({
		remove,
		approve: (name) =>
			setPeople((current) => current.map((person) => (person.name === name ? { name } : person))),
		prepend: (name) => setPeople((current) => [{ name }, ...current]),
	}));
	const shown = people.filter((person) => person.name.startsWith(search));

	return (
		<>
			<h1>People</h1>
			<input
				aria-label="Search people"
				value={search}
				onChange={(event) => setSearch(event.target.value)}
			/>
			<DropdownMenu>
				<DropdownMenu.Trigger render={<Button>Columns</Button>} />
				<DropdownMenu.Content>
					<DropdownMenu.Item>Name</DropdownMenu.Item>
				</DropdownMenu.Content>
			</DropdownMenu>
			<DataTable>
				<thead>
					<tr>
						<th scope="col">Name</th>
						<th scope="col">Actions</th>
					</tr>
				</thead>
				<tbody>
					{shown.map(({ name, pending }) => (
						<tr key={name}>
							<td>
								<RowTitleButton>{name}</RowTitleButton>
							</td>
							<td>
								{pending && <Button aria-label={`Approve ${name}`}>Approve</Button>}
								<RowActionsMenu label={`Actions for ${name}`}>
									<DropdownMenu.Item onClick={() => setArchiving(name)}>Archive</DropdownMenu.Item>
									<DropdownMenu.Item onClick={() => setDetails(name)}>Details</DropdownMenu.Item>
									<DropdownMenu.Item onClick={() => setDeleting(name)}>Delete</DropdownMenu.Item>
								</RowActionsMenu>
								{/* Like the content list's trash dialog, which leaves with its row. */}
								<Dialog.Root
									open={archiving === name}
									onOpenChange={(open) => !open && setArchiving(null)}
								>
									<Dialog>
										<Dialog.Title>{`Archive ${name}?`}</Dialog.Title>
										<Dialog.Close
											render={<Button onClick={() => remove(name)}>{`Archive ${name}`}</Button>}
										/>
									</Dialog>
								</Dialog.Root>
							</td>
						</tr>
					))}
				</tbody>
			</DataTable>
			<Dialog.Root open={!!details} onOpenChange={(open) => !open && setDetails(null)}>
				<Dialog>
					<Dialog.Title>{`${details} details`}</Dialog.Title>
					<Dialog.Close render={<Button>Close</Button>} />
				</Dialog>
			</Dialog.Root>
			{/* Like the content types list, whose dialog closes as the delete starts. */}
			<ConfirmDialog
				open={!!deleting}
				onClose={() => setDeleting(null)}
				title={`Delete ${deleting}?`}
				description="Gone for good."
				confirmLabel="Delete"
				pendingLabel="Deleting..."
				isPending={false}
				error={null}
				onConfirm={() => {
					if (deleting) remove(deleting);
					setDeleting(null);
				}}
			/>
		</>
	);
}

function actions(name: string) {
	return page.getByRole("button", { name: `Actions for ${name}`, exact: true });
}

async function openMenuFromKeyboard(name: string) {
	actions(name).element().focus();
	await userEvent.keyboard("{Enter}");
	await expect.element(page.getByRole("menuitem").first()).toHaveFocus();
}

async function nextFrames() {
	for (let i = 0; i < 3; i++) await new Promise((resolve) => requestAnimationFrame(resolve));
}

describe("DataTable row focus", () => {
	beforeEach(async () => {
		await userEvent.hover(document.body);
	});

	it("moves focus to the next row's actions button when the focused row leaves", async () => {
		const handle = React.createRef<PeopleHandle>();
		await render(<PeopleTable handle={handle} />);
		actions("Grace").element().focus();

		handle.current!.remove("Grace");

		await expect.element(actions("Grace")).not.toBeInTheDocument();
		await expect.element(actions("Hedy")).toHaveFocus();
	});

	it("moves focus to the new last row when the last row leaves", async () => {
		const handle = React.createRef<PeopleHandle>();
		await render(<PeopleTable handle={handle} />);
		actions("Katherine").element().focus();

		handle.current!.remove("Katherine");

		await expect.element(actions("Katherine")).not.toBeInTheDocument();
		await expect.element(actions("Hedy")).toHaveFocus();
	});

	it("moves focus to the new last row's actions button when the last row leaves from its name", async () => {
		const handle = React.createRef<PeopleHandle>();
		const screen = await render(<PeopleTable handle={handle} />);
		screen.getByRole("button", { name: "Katherine", exact: true }).element().focus();

		handle.current!.remove("Katherine");

		await expect.element(actions("Katherine")).not.toBeInTheDocument();
		await expect.element(actions("Hedy")).toHaveFocus();
	});

	it("moves focus to the same control in the next row", async () => {
		const handle = React.createRef<PeopleHandle>();
		const screen = await render(<PeopleTable handle={handle} />);
		screen.getByRole("button", { name: "Grace", exact: true }).element().focus();

		handle.current!.remove("Grace");

		await expect.element(screen.getByRole("button", { name: "Hedy", exact: true })).toHaveFocus();
	});

	it("moves focus to the row that takes the place of two rows leaving together", async () => {
		const handle = React.createRef<PeopleHandle>();
		await render(<PeopleTable handle={handle} />);
		actions("Grace").element().focus();

		handle.current!.remove("Grace", "Hedy");

		await expect.element(actions("Hedy")).not.toBeInTheDocument();
		await expect.element(actions("Katherine")).toHaveFocus();
	});

	it("moves focus to the next row when a row is added above as the focused row leaves", async () => {
		const handle = React.createRef<PeopleHandle>();
		await render(<PeopleTable handle={handle} />);
		actions("Grace").element().focus();

		handle.current!.remove("Grace");
		handle.current!.prepend("Mary");

		await expect.element(actions("Mary")).toBeInTheDocument();
		await expect.element(actions("Hedy")).toHaveFocus();
	});

	it("moves focus within a row when its focused control leaves and the row stays", async () => {
		const handle = React.createRef<PeopleHandle>();
		const screen = await render(
			<PeopleTable handle={handle} initial={[{ name: "Ada" }, { name: "Grace", pending: true }]} />,
		);
		screen.getByRole("button", { name: "Approve Grace" }).element().focus();

		handle.current!.approve("Grace");

		await expect
			.element(screen.getByRole("button", { name: "Approve Grace" }))
			.not.toBeInTheDocument();
		await expect.element(actions("Grace")).toHaveFocus();
	});

	it("leaves focus in a search box while typing removes rows", async () => {
		const screen = await render(<PeopleTable />);
		actions("Grace").element().focus();
		const search = screen.getByRole("textbox", { name: "Search people" });
		search.element().focus();

		await userEvent.keyboard("Hed");

		await expect.element(actions("Grace")).not.toBeInTheDocument();
		await expect.element(search).toHaveFocus();
		await expect.element(search).toHaveValue("Hed");
	});

	it("leaves focus alone after a pointer press moves it off the table", async () => {
		const handle = React.createRef<PeopleHandle>();
		const screen = await render(<PeopleTable handle={handle} />);
		actions("Grace").element().focus();
		await screen.getByRole("heading", { name: "People" }).click();
		expect(document.activeElement).toBe(document.body);

		handle.current!.remove("Grace");

		await expect.element(actions("Grace")).not.toBeInTheDocument();
		await nextFrames();
		expect(document.activeElement).toBe(document.body);
	});

	it("moves focus when a key press follows a click that left focus in the row", async () => {
		const handle = React.createRef<PeopleHandle>();
		const screen = await render(<PeopleTable handle={handle} />);
		const grace = screen.getByRole("button", { name: "Grace", exact: true });
		grace.element().focus();
		await grace.click();
		await userEvent.keyboard("{Shift}");

		handle.current!.remove("Grace");

		await expect.element(screen.getByRole("button", { name: "Hedy", exact: true })).toHaveFocus();
	});

	async function deleteFromDialog(name: string) {
		await openMenuFromKeyboard(name);
		await userEvent.keyboard("{End}{Enter}");
		const dialog = page.getByRole("dialog", { name: `Delete ${name}?` });
		await expect.element(dialog).toBeVisible();
		dialog.getByRole("button", { name: "Delete", exact: true }).element().focus();
		await userEvent.keyboard("{Enter}");
		await expect.element(dialog).not.toBeInTheDocument();
	}

	it("moves focus to the next row once a dialog the row left under closes", async () => {
		await render(<PeopleTable />);

		await deleteFromDialog("Grace");

		await expect.element(actions("Hedy")).toHaveFocus();
	});

	it("moves focus to the next row when the closing dialog hands it to another row", async () => {
		await render(<PeopleTable />);
		// With the row it opened from gone, Base UI returns focus to the last control another popup opened from.
		await openMenuFromKeyboard("Ada");
		await userEvent.keyboard("{Escape}");
		await expect.element(actions("Ada")).toHaveFocus();

		await deleteFromDialog("Grace");

		await expect.element(actions("Hedy")).toHaveFocus();
	});

	it("moves focus to the next row when the closing dialog hands it to a control outside the table", async () => {
		const screen = await render(<PeopleTable />);
		const columns = screen.getByRole("button", { name: "Columns" });
		columns.element().focus();
		await userEvent.keyboard("{Enter}");
		await expect.element(screen.getByRole("menuitem", { name: "Name" })).toHaveFocus();
		await userEvent.keyboard("{Escape}");
		await expect.element(columns).toHaveFocus();

		await deleteFromDialog("Grace");

		await expect.element(actions("Hedy")).toHaveFocus();
	});

	it("moves focus to the next row when a dialog that outlived the row is closed", async () => {
		const handle = React.createRef<PeopleHandle>();
		await render(<PeopleTable handle={handle} />);
		await openMenuFromKeyboard("Grace");
		await userEvent.keyboard("{ArrowDown}{Enter}");
		const dialog = page.getByRole("dialog", { name: "Grace details" });
		await expect.element(dialog).toBeVisible();
		handle.current!.remove("Grace");
		await expect.element(actions("Grace")).not.toBeInTheDocument();

		await userEvent.keyboard("{Escape}");

		await expect.element(dialog).not.toBeInTheDocument();
		await expect.element(actions("Hedy")).toHaveFocus();
	});

	it("moves focus to the next row when a dialog leaves with its row", async () => {
		await render(<PeopleTable />);
		await openMenuFromKeyboard("Grace");
		await userEvent.keyboard("{Home}{Enter}");
		const dialog = page.getByRole("dialog", { name: "Archive Grace?" });
		await expect.element(dialog).toBeVisible();
		dialog.getByRole("button", { name: "Archive Grace" }).element().focus();

		await userEvent.keyboard("{Enter}");

		await expect.element(dialog).not.toBeInTheDocument();
		await expect.element(actions("Hedy")).toHaveFocus();
	});
});
