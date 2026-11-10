import { Badge } from "@cloudflare/kumo";
import * as React from "react";
import { describe, expect, it } from "vitest";

import "../../dist/styles.css";
import {
	DataTable,
	RowMeta,
	secondaryColumn,
	tertiaryColumn,
} from "../../src/components/DataTable.js";
import { render } from "../utils/render.js";

function PeopleTable({ width }: { width: number }) {
	return (
		<div style={{ width }}>
			<DataTable>
				<thead>
					<tr>
						<th scope="col">Name</th>
						<th scope="col" {...secondaryColumn}>
							Kind
						</th>
						<th scope="col" {...tertiaryColumn}>
							Notes
						</th>
					</tr>
				</thead>
				<tbody>
					{[
						["Ada Lovelace", "Mathematician", "https://en.wikipedia.org/wiki/Ada_Lovelace"],
						["Grace Hopper", "Computer scientist", "https://en.wikipedia.org/wiki/Grace_Hopper"],
					].map(([name, kind, notes]) => (
						<tr key={name}>
							<td>
								{name}
								<RowMeta>{kind}</RowMeta>
							</td>
							<td {...secondaryColumn}>{kind}</td>
							<td {...tertiaryColumn}>{notes}</td>
						</tr>
					))}
				</tbody>
			</DataTable>
		</div>
	);
}

describe("DataTable column priority", () => {
	it.each([
		{ width: 360, headers: ["Name"], meta: true },
		{ width: 560, headers: ["Name", "Kind"], meta: false },
		{ width: 900, headers: ["Name", "Kind", "Notes"], meta: false },
	])("shows $headers in a $width px table", async ({ width, headers, meta }) => {
		const screen = await render(<PeopleTable width={width} />);
		const table = screen.getByRole("table").element() as HTMLTableElement;
		const tray = table.parentElement!;
		const visibleHeaders = [...table.querySelectorAll("th")]
			.filter((th) => th.checkVisibility())
			.map((th) => th.textContent);
		const nameCell = screen.getByRole("cell", { name: "Ada Lovelace" });
		const firstRowCells = [...table.tBodies[0]!.rows[0]!.cells].filter((cell) =>
			cell.checkVisibility(),
		);

		expect(visibleHeaders).toEqual(headers);
		expect(nameCell.getByText("Mathematician").element().checkVisibility()).toBe(meta);
		expect(tray.scrollWidth).toBeLessThanOrEqual(tray.clientWidth);
		expect(firstRowCells).toHaveLength(headers.length);
		expect(
			parseFloat(getComputedStyle(firstRowCells.at(-1)!).borderStartEndRadius),
		).toBeGreaterThan(0);
	});

	it.each([
		{ width: 560, secondary: false, tertiary: true },
		{ width: 900, secondary: false, tertiary: false },
	])(
		"shows a tertiary row's details while its column is hidden, in a $width px table",
		async ({ width, secondary, tertiary }) => {
			const screen = await render(
				<div style={{ width }}>
					<DataTable>
						<thead>
							<tr>
								<th scope="col">Name</th>
								<th scope="col" {...secondaryColumn}>
									Kind
								</th>
								<th scope="col" {...tertiaryColumn}>
									Notes
								</th>
							</tr>
						</thead>
						<tbody>
							<tr>
								<td>
									Ada Lovelace
									<RowMeta>Mathematician</RowMeta>
									<RowMeta priority="tertiary">Analytical Engine notes</RowMeta>
								</td>
								<td {...secondaryColumn}>Mathematician</td>
								<td {...tertiaryColumn}>Analytical Engine notes</td>
							</tr>
						</tbody>
					</DataTable>
				</div>,
			);
			const nameCell = screen.getByRole("cell", { name: /^Ada Lovelace/ });

			expect(nameCell.getByText("Mathematician").element().checkVisibility()).toBe(secondary);
			expect(nameCell.getByText("Analytical Engine notes").element().checkVisibility()).toBe(
				tertiary,
			);
		},
	);
});

describe("DataTable at phone width", () => {
	it("wraps a long badge in the row details instead of widening the table", async () => {
		const screen = await render(
			<div style={{ width: 272 }}>
				<DataTable>
					<thead>
						<tr>
							<th scope="col">Name</th>
							<th scope="col">
								<span className="sr-only">Actions</span>
							</th>
						</tr>
					</thead>
					<tbody>
						<tr>
							<td>
								Ada Lovelace
								<RowMeta>
									<Badge>Ausstehende Änderungen an der Veröffentlichung</Badge>
								</RowMeta>
							</td>
							<td>
								<span style={{ display: "inline-block", width: 26, height: 26 }} />
							</td>
						</tr>
					</tbody>
				</DataTable>
			</div>,
		);
		const tray = screen.getByRole("table").element().parentElement!;
		const badge = screen.getByText("Ausstehende Änderungen an der Veröffentlichung").element();
		const cell = badge.closest("td")!.getBoundingClientRect();
		const bounds = badge.getBoundingClientRect();

		expect(tray.scrollWidth).toBeLessThanOrEqual(tray.clientWidth);
		expect(badge.scrollWidth).toBeLessThanOrEqual(badge.clientWidth);
		expect(bounds.left).toBeGreaterThanOrEqual(cell.left);
		expect(bounds.right).toBeLessThanOrEqual(cell.right);
	});

	it("hides only cells that carry a priority, not elements inside a cell", async () => {
		const screen = await render(
			<div style={{ width: 272 }}>
				<DataTable>
					<tbody>
						<tr>
							<td>
								<span {...secondaryColumn}>Plugin badge</span>
							</td>
						</tr>
					</tbody>
				</DataTable>
			</div>,
		);

		await expect.element(screen.getByText("Plugin badge")).toBeVisible();
	});

	it("starts cell text closer to the tray edge in a narrow table than in a wide one", async () => {
		const screen = await render(<PeopleTable width={272} />);
		const insets = () => {
			const tray = screen.getByRole("table").element().parentElement!.getBoundingClientRect();
			const textStart = (element: Element) => {
				const range = document.createRange();
				range.selectNodeContents(element.firstChild!);
				return range.getBoundingClientRect().left - tray.left;
			};
			return [
				textStart(screen.getByRole("columnheader", { name: "Name" }).element()),
				textStart(screen.getByRole("cell", { name: "Ada Lovelace" }).element()),
			];
		};

		const narrow = insets();
		await screen.rerender(<PeopleTable width={900} />);
		const wide = insets();

		for (const [index, inset] of narrow.entries()) {
			expect(inset).toBeGreaterThan(0);
			expect(inset).toBeLessThan(wide[index]!);
		}
	});
});
