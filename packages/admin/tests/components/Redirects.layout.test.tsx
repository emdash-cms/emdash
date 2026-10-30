import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import type { NotFoundSummary, Redirect } from "../../src/lib/api/redirects.js";
import { render } from "../utils/render.js";

vi.mock("../../src/lib/api/redirects.js", () => ({
	createRedirect: vi.fn(),
	deleteRedirect: vi.fn(),
	fetch404Summary: vi.fn(),
	fetchRedirects: vi.fn(),
	updateRedirect: vi.fn(),
}));

import { Redirects } from "../../src/components/Redirects.js";
import { fetch404Summary, fetchRedirects } from "../../src/lib/api/redirects.js";

const longPath = "/campaigns/2026/spring-launch/landing-pages/a-very-long-path-segment-for-layout";
const lastSeen = "2026-10-29T10:00:00.000Z";
const lastSeenText = new Intl.DateTimeFormat("en").format(new Date(lastSeen));
const hitsText = (count: number) => `${count.toLocaleString("en")} ${count === 1 ? "hit" : "hits"}`;

function redirect(id: string, overrides: Partial<Redirect>): Redirect {
	return {
		id,
		source: `/${id}`,
		destination: `/${id}-new`,
		type: 301,
		isPattern: false,
		enabled: true,
		hits: 0,
		lastHitAt: null,
		groupName: null,
		auto: false,
		createdAt: "2026-08-10T00:00:00.000Z",
		updatedAt: "2026-08-10T00:00:00.000Z",
		...overrides,
	};
}

const redirects = [
	redirect("long", { source: longPath, destination: `${longPath}-moved`, hits: 12_345 }),
	redirect("unbroken", { source: `/${"a".repeat(80)}`, destination: `/${"b".repeat(80)}` }),
	redirect("auto", { source: "/blog/[slug]", destination: "/articles/[slug]", auto: true }),
	redirect("loop", { source: "/loop-a", destination: "/loop-b", type: 302 }),
	redirect("disabled", { source: "/old-pricing", destination: "/pricing", enabled: false }),
	redirect("gone", { source: "/discontinued", destination: "", type: 410 }),
];

const notFound: NotFoundSummary[] = [
	{ path: `${longPath}-missing`, count: 12_345, lastSeen, topReferrer: null },
	{ path: `/${"x".repeat(90)}`, count: 3, lastSeen, topReferrer: null },
	{ path: "/team", count: 1, lastSeen, topReferrer: null },
];

vi.mocked(fetchRedirects).mockResolvedValue({ items: redirects, loopRedirectIds: ["loop"] });
vi.mocked(fetch404Summary).mockResolvedValue(notFound);

function renderAtPhoneWidth(dir: "ltr" | "rtl") {
	return render(
		<div dir={dir} style={{ width: 272 }}>
			<Redirects />
		</div>,
	);
}

async function phoneTable(screen: Awaited<ReturnType<typeof renderAtPhoneWidth>>) {
	const table = screen.getByRole("table");
	await expect.element(table).toBeVisible();
	const tray = table.element().parentElement!;
	expect(tray.getBoundingClientRect().width).toBe(272);
	expect(tray.scrollWidth).toBeLessThanOrEqual(tray.clientWidth);
	return tray.getBoundingClientRect();
}

function expectInside(element: Element, box: DOMRect) {
	const bounds = element.getBoundingClientRect();
	expect(bounds.width).toBeGreaterThan(0);
	expect(bounds.left).toBeGreaterThanOrEqual(box.left);
	expect(bounds.right).toBeLessThanOrEqual(box.right);
}

/** The opacity an element shows at, with its ancestors' opacity applied. */
function shownOpacity(element: Element) {
	let opacity = 1;
	for (let node: Element | null = element; node; node = node.parentElement) {
		opacity *= Number(getComputedStyle(node).opacity);
	}
	return opacity;
}

/** A row's controls and the elements holding its visible text. */
function shownParts(row: HTMLTableRowElement) {
	const parts: Element[] = [...row.querySelectorAll("button")];
	const walker = document.createTreeWalker(row, NodeFilter.SHOW_TEXT);
	while (walker.nextNode()) {
		const parent = walker.currentNode.parentElement!;
		if (walker.currentNode.textContent!.trim() && parent.checkVisibility()) parts.push(parent);
	}
	return parts;
}

/** Every line of a wrapped path starts at the page's start edge, the right one in RTL. */
function expectLinesFromStart(element: Element, dir: "ltr" | "rtl") {
	const range = document.createRange();
	range.selectNodeContents(element);
	const starts = Array.from(range.getClientRects(), (line) =>
		Math.round(dir === "rtl" ? line.right : line.left),
	);
	expect(new Set(starts).size).toBe(1);
}

describe("Redirects at phone width", () => {
	it.each(["ltr", "rtl"] as const)(
		"shows each redirect's source, destination, details, and controls in a 272px table in %s",
		async (dir) => {
			const screen = await renderAtPhoneWidth(dir);
			const box = await phoneTable(screen);

			for (const name of ["Code", "Hits"]) {
				expect(
					screen.getByRole("columnheader", { name, includeHidden: true }).element(),
				).not.toBeVisible();
			}
			for (const item of redirects) {
				const source = screen.getByRole("button", {
					name: `Edit redirect ${item.source}`,
					exact: true,
				});
				await expect.element(source).toBeVisible();
				expectInside(source.element(), box);
				expectLinesFromStart(source.element(), dir);
				const cell = page.elementLocator(source.element().closest("td")!);
				const details = [String(item.type), hitsText(item.hits)];
				for (const text of item.destination ? [item.destination, ...details] : details) {
					const detail = cell.getByText(text, { exact: true });
					await expect.element(detail).toBeVisible();
					expectInside(detail.element(), box);
				}
				if (item.destination) {
					expectLinesFromStart(cell.getByText(item.destination, { exact: true }).element(), dir);
				}
			}

			const switches = screen.getByRole("switch").elements();
			const menus = screen.getByRole("button", { name: /^Actions for redirect / }).elements();
			expect(switches).toHaveLength(redirects.length);
			expect(menus).toHaveLength(redirects.length);
			for (const control of [...switches, ...menus]) expectInside(control, box);
		},
	);

	it.each(["ltr", "rtl"] as const)(
		"shows each 404's path, hits, last visit, and actions in a 272px table in %s",
		async (dir) => {
			const screen = await renderAtPhoneWidth(dir);
			await screen.getByRole("tab", { name: "404 Errors" }).click();
			const box = await phoneTable(screen);

			for (const name of ["Hits", "Last seen"]) {
				expect(
					screen.getByRole("columnheader", { name, includeHidden: true }).element(),
				).not.toBeVisible();
			}
			for (const item of notFound) {
				const path = screen.getByText(item.path, { exact: true });
				await expect.element(path).toBeVisible();
				expectInside(path.element(), box);
				expectLinesFromStart(path.element(), dir);
				const cell = page.elementLocator(path.element().closest("td")!);
				for (const text of [hitsText(item.count), lastSeenText]) {
					await expect.element(cell.getByText(text, { exact: true })).toBeVisible();
				}
				for (const name of [
					`Create redirect for ${item.path}`,
					`Mark ${item.path} as Gone (410)`,
				]) {
					const action = screen.getByRole("button", { name, exact: true });
					await expect.element(action).toBeVisible();
					expectInside(action.element(), box);
				}
			}
		},
	);
});

describe("Disabled redirects", () => {
	it.each([272, 1024])("fade their contents but not their cells in a %ipx table", async (width) => {
		const screen = await render(
			<div style={{ width }}>
				<Redirects />
			</div>,
		);
		const source = (path: string) =>
			screen.getByRole("button", { name: `Edit redirect ${path}`, exact: true });
		await expect.element(source("/old-pricing")).toBeVisible();
		const disabled = source("/old-pricing").element().closest("tr")!;
		const enabled = source("/loop-a").element().closest("tr")!;

		for (const cell of disabled.cells) expect(shownOpacity(cell)).toBe(1);
		const parts = shownParts(disabled);
		expect(parts.map((part) => part.textContent)).toEqual(
			expect.arrayContaining(["/old-pricing", "/pricing", "301"]),
		);
		for (const part of parts) expect(shownOpacity(part)).toBe(0.5);
		for (const part of shownParts(enabled)) expect(shownOpacity(part)).toBe(1);
	});
});
