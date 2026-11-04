import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../../dist/styles.css";
import { RevisionViewBar } from "../../../src/components/revisions/RevisionViewBar";
import { render } from "../../utils/render.tsx";

/** A Saturday, so the Wednesday before it reads as "Wednesday", the longest English weekday. */
const NOW = new Date(2026, 9, 17, 12);

function lastWednesdayEvening(): string {
	return new Date(2026, 9, 14, 22, 2).toISOString();
}

function thisMorning(): string {
	return new Date(2026, 9, 17, 9, 12).toISOString();
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
	return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

function BarAt({
	width,
	createdAt,
	statuses = false,
	published = statuses,
	stepper = statuses,
	current = false,
	firstVersion = false,
	author = "Maya Chen",
	onExit = vi.fn(),
}: {
	width: number;
	createdAt: string;
	/** Shows the version as published and the same as the current one, on a phone with arrows. */
	statuses?: boolean;
	published?: boolean;
	/** Adds the arrows and Show changes, as when the Revisions list is off screen. */
	stepper?: boolean;
	/** The current version, which has nothing to restore. */
	current?: boolean;
	/** The first version, which has nothing to compare with. */
	firstVersion?: boolean;
	author?: string;
	onExit?: () => void;
}) {
	const titleRef = React.useRef<HTMLHeadingElement>(null);
	const dockRef = React.useRef<HTMLDivElement>(null);
	return (
		<div style={{ width, ["--emdash-editor-gutter" as string]: "0px" }}>
			<RevisionViewBar
				collection="posts"
				entryId="post_1"
				revision={{
					id: "rev-1",
					collection: "posts",
					entryId: "post_1",
					data: {},
					authorId: "user-maya",
					author: { id: "user-maya", name: author },
					createdAt,
				}}
				authorColor="blue"
				isCurrent={current}
				isPublished={published}
				sameAsCurrent={statuses}
				hasDraft
				scheduled={false}
				canShowChanges={!firstVersion}
				showChanges
				onShowChangesChange={vi.fn()}
				onExit={onExit}
				showStepper={stepper}
				hasOlder
				hasNewer
				onStep={vi.fn()}
				readOnly={false}
				saveBusy={false}
				isDirty={false}
				restorePending={false}
				onRestoreStart={vi.fn()}
				onRestoreFailed={vi.fn()}
				onRestoreSettled={vi.fn()}
				titleRef={titleRef}
				dockRef={dockRef}
			/>
		</div>
	);
}

function renderBar(element: React.ReactElement) {
	return render(element, { wrapper: Toasty });
}

describe("RevisionViewBar", () => {
	beforeEach(() => {
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("goes back to editing on the Esc its button's tooltip advertises", async () => {
		const onExit = vi.fn();
		const screen = await renderBar(
			<BarAt width={2000} createdAt={lastWednesdayEvening()} onExit={onExit} />,
		);
		screen.getByRole("heading", { level: 2 }).element().focus();
		await userEvent.keyboard("{Tab}");
		await expect.element(screen.getByRole("button", { name: "Back to editing" })).toHaveFocus();
		await expect.element(screen.getByText("Back to editing (Esc)")).toBeVisible();

		await userEvent.keyboard("{Escape}");
		expect(onExit).toHaveBeenCalledOnce();
	});

	it("puts Show changes and Restore on their own row under the version", async () => {
		const screen = await renderBar(<BarAt width={2000} createdAt={lastWednesdayEvening()} />);
		const restore = screen.getByRole("button", { name: "Restore", exact: true });
		await expect.element(restore).toBeVisible();
		const title = screen.getByRole("heading", { level: 2 }).element().getBoundingClientRect();
		const toggle = screen.getByRole("switch", { name: "Show changes" }).element();
		expect(restore.element().getBoundingClientRect().top).toBeGreaterThan(title.bottom);
		expect(toggle.getBoundingClientRect().top).toBeGreaterThan(title.bottom);
	});

	it("keeps the version on one line when the bar has room", async () => {
		const screen = await renderBar(
			<BarAt width={2000} createdAt={lastWednesdayEvening()} published />,
		);
		const title = screen.getByRole("heading", { level: 2 });
		await expect.element(title).toBeVisible();
		const status = screen.getByText("Published", { exact: true }).element().getBoundingClientRect();
		expect(status.top).toBeLessThan(title.element().getBoundingClientRect().bottom);
	});

	it("shows the whole version line, and why there's nothing to restore in Restore's place", async () => {
		const screen = await renderBar(
			<BarAt width={2000} createdAt={lastWednesdayEvening()} statuses stepper={false} />,
		);
		const reason = screen.getByText("Same as current version");
		await expect.element(reason).toBeVisible();
		const title = screen.getByRole("heading", { level: 2 }).element();
		expect(reason.element().getBoundingClientRect().top).toBeGreaterThan(
			title.getBoundingClientRect().bottom,
		);
		const texts = [title, screen.getByText("Maya Chen").element(), reason.element()];
		for (const text of texts) expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth);
	});

	it("keeps a long author name and the statuses inside the bar on a 320px phone", async () => {
		const screen = await renderBar(
			<BarAt
				width={288}
				createdAt={lastWednesdayEvening()}
				statuses
				author="Christopher Montgomery-Smith of the Editorial Team"
			/>,
		);
		const status = screen.getByText("Same as current version");
		await expect.element(status).toBeVisible();
		const card = status.element().closest("section")!;
		const name = screen.getByText("Christopher Montgomery-Smith", { exact: false }).element();
		expect(card.scrollWidth).toBeLessThanOrEqual(card.clientWidth);
		const controls = [
			...screen.getByRole("button").elements(),
			screen.getByRole("switch", { name: "Show changes" }).element(),
		];
		for (const text of [status, screen.getByText("Published", { exact: true })]) {
			const box = text.element().getBoundingClientRect();
			for (const control of controls) {
				expect(overlaps(box, control.getBoundingClientRect())).toBe(false);
			}
		}
		expect(name.scrollWidth).toBeGreaterThan(name.clientWidth);
	});

	it("keeps its size whether or not there is something to restore or compare", async () => {
		const screen = await renderBar(
			<>
				<BarAt width={2000} createdAt={lastWednesdayEvening()} />
				<BarAt width={2000} createdAt={lastWednesdayEvening()} current />
				<BarAt width={2000} createdAt={lastWednesdayEvening()} firstVersion />
			</>,
		);
		const switches = screen.getByRole("switch", { name: "Show changes" });
		await expect.element(switches.nth(2)).toBeDisabled();
		expect(screen.getByRole("button", { name: "Restore", exact: true }).elements()).toHaveLength(2);
		const heights = Array.from(
			screen.container.querySelectorAll("section"),
			(bar) => bar.getBoundingClientRect().height,
		);
		expect(heights).toEqual([heights[0], heights[0], heights[0]]);
	});

	it("keeps its height and its arrows in place on a phone, whatever the version says", async () => {
		const screen = await renderBar(
			<>
				<BarAt width={343} createdAt={thisMorning()} stepper />
				<BarAt width={343} createdAt={lastWednesdayEvening()} statuses />
			</>,
		);
		await expect.element(screen.getByText("Same as current version")).toBeVisible();
		const bars = [...screen.container.querySelectorAll("section")];
		const olderArrows = screen.getByRole("button", { name: "Older version" }).elements();
		const layout = bars.map((bar, index) => {
			const box = bar.getBoundingClientRect();
			const older = olderArrows[index]!.getBoundingClientRect();
			return {
				height: box.height,
				arrowTop: older.top - box.top,
				arrowEnd: box.right - older.right,
			};
		});
		expect(layout[1]).toEqual(layout[0]);
	});
});
