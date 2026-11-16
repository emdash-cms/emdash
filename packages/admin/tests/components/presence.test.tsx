import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { FieldPresence } from "../../src/components/presence/FieldPresence";
import { PresenceAvatars } from "../../src/components/presence/PresenceAvatars";
import type { RoomEditing } from "../../src/lib/co-editing/types";
import { createRoom } from "../co-editing/fake-room";
import { LoopbackRoom, settle } from "../co-editing/loopback-room";
import {
	resetTransportHealth,
	startSession,
	type TestSession,
} from "../co-editing/session-harness";
import { adminRoot } from "../utils/form-layout";
import { render } from "../utils/render";

const LABELS: Record<string, string> = { title: "Title", excerpt: "Excerpt", body: "Body" };
const fieldLabel = (field: string) => LABELS[field] ?? field;
const PHOTO = `data:image/svg+xml,${encodeURIComponent(
	'<svg xmlns="http://www.w3.org/2000/svg" width="8" height="8"><rect width="8" height="8" fill="teal"/></svg>',
)}`;

/** The circles in the editor bar, "+N" included. */
function faces(container: Element) {
	return [...container.querySelectorAll<HTMLElement>("[role=group] > [data-presence-face]")];
}

/** Each circle's lift and scale, as hovering or focusing one sets them. */
function lifts(container: Element) {
	return faces(container).map((face) => [
		face.style.getPropertyValue("--shift"),
		face.style.getPropertyValue("--scale-active"),
	]);
}

let sessions: TestSession[] = [];

beforeEach(resetTransportHealth);
afterEach(async () => {
	for (const { session } of sessions) session.dispose();
	sessions = [];
	vi.restoreAllMocks();
	await cdp().send("Emulation.setEmulatedMedia", { features: [] });
	resetTransportHealth();
});

async function reduceMotion(reduce: boolean) {
	await cdp().send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: reduce ? "reduce" : "no-preference" }],
	});
}

/** A field in the editor of `room`, as the content editor marks it. */
function Field({ room, name }: { room: RoomEditing; name: string }) {
	return (
		<div data-co-editing-field={name} className="relative">
			<label className="block text-base">
				{fieldLabel(name)}
				<input aria-label={`${fieldLabel(name)} of ${room.id}`} className="block w-full" />
			</label>
			<FieldPresence room={room} field={name} />
		</div>
	);
}

function Editor({ room, fields }: { room: RoomEditing; fields: string[] }) {
	return (
		<div data-co-editing-room={room.id} className="grid w-[32rem] gap-6 p-4">
			{fields.map((name) => (
				<Field key={name} room={room} name={name} />
			))}
		</div>
	);
}

async function join(room: LoopbackRoom) {
	const session = startSession(room);
	sessions.push(session);
	await settle();
	const view = session.view();
	if (view.mode !== "room") throw new Error(`Expected a room, got ${view.mode}`);
	return Object.assign(session, { editing: view.room });
}

const userName = (session: Awaited<ReturnType<typeof join>>) =>
	`User ${session.replica().doc.clientID}`;

describe("presence avatars", () => {
	it("shows up to three people, then everyone in a list behind +N", async () => {
		const fake = createRoom({});
		fake.present("u-ana", "Ana Lima", "title");
		fake.present("u-ben", "Ben Okafor");
		fake.present("u-cleo", "Cleo Park", "excerpt");
		const screen = await render(<PresenceAvatars room={fake.room} fieldLabel={fieldLabel} />);

		await expect.element(screen.getByRole("group", { name: "3 other people here" })).toBeVisible();
		expect(screen.getByRole("button").elements()).toHaveLength(3);
		expect(screen.getByRole("button", { name: "Show 1 more person" }).query()).toBeNull();

		fake.present("u-dev", "Dev Iyer", "title");

		await expect.element(screen.getByRole("group", { name: "4 other people here" })).toBeVisible();
		const more = screen.getByRole("button", { name: "Show 1 more person" });
		await expect.element(more).toHaveTextContent("+1");
		expect(screen.getByRole("button", { name: /·/ }).elements()).toHaveLength(3);

		await more.click();
		const list = page.getByRole("dialog", { name: "People in this entry" });
		await expect.element(list).toBeVisible();
		const rows = list.getByRole("listitem").elements();
		expect(rows.map((row) => row.textContent)).toEqual([
			"ALAna LimaEditing Title",
			"BOBen OkaforViewing",
			"CPCleo ParkEditing Excerpt",
			"DIDev IyerEditing Title",
		]);
	});

	it("names the field each person is in, or says they are viewing", async () => {
		const fake = createRoom({});
		fake.present("u-ana", "Ana Lima", "excerpt");
		fake.present("u-ben", "Ben Okafor");
		const screen = await render(<PresenceAvatars room={fake.room} fieldLabel={fieldLabel} />);

		const ana = screen.getByRole("button", { name: "Ana Lima · Editing Excerpt" });
		await expect.element(ana).toHaveTextContent("AL");
		await userEvent.hover(ana.element());
		await expect.element(page.getByText("Ana Lima · Editing Excerpt")).toBeVisible();

		const ben = screen.getByRole("button", { name: "Ben Okafor · Viewing" });
		await userEvent.hover(ben.element());
		await expect.element(page.getByText("Ben Okafor · Viewing")).toBeVisible();
		await expect.element(ben).toHaveAttribute("aria-disabled", "true");
		await expect.element(ana).not.toHaveAttribute("aria-disabled");
	});

	it("brings a person's field into view, at their caret in rich text, at once under reduced motion", async () => {
		const fake = createRoom({});
		fake.present("u-ana", "Ana Lima", "excerpt");
		fake.present("u-ben", "Ben Okafor", "body");
		fake.present("u-cleo", "Cleo Park");
		const scroll = vi.spyOn(Element.prototype, "scrollIntoView").mockImplementation(() => {});
		const screen = await render(
			<>
				<PresenceAvatars room={fake.room} fieldLabel={fieldLabel} />
				<div data-co-editing-room={fake.room.id}>
					<div data-co-editing-field="excerpt">Excerpt</div>
					<div data-co-editing-field="body">
						Body
						<span className="emdash-remote-caret" data-user="u-ben" />
					</div>
				</div>
			</>,
		);

		await screen.getByRole("button", { name: "Ana Lima · Editing Excerpt" }).click();
		expect(scroll).toHaveBeenLastCalledWith({ behavior: "smooth", block: "center" });
		expect(scroll.mock.contexts.at(-1)).toBe(
			document.querySelector('[data-co-editing-field="excerpt"]'),
		);

		await reduceMotion(true);
		await screen.getByRole("button", { name: "Ben Okafor · Editing Body" }).click();
		expect(scroll).toHaveBeenLastCalledWith({ behavior: "instant", block: "center" });
		expect(scroll.mock.contexts.at(-1)).toBe(document.querySelector(".emdash-remote-caret"));

		scroll.mockClear();
		// Playwright won't click a control marked unavailable unless forced; a person still can.
		await screen.getByRole("button", { name: "Cleo Park · Viewing" }).click({ force: true });
		expect(scroll).not.toHaveBeenCalled();
	});

	it("shows only as many circles as the room its title gives up, so the bar never wraps", async () => {
		const fake = createRoom({});
		for (const name of ["Ana Lima", "Ben Okafor", "Cleo Park", "Dev Iyer", "Eli Cohen"]) {
			fake.present(`u-${name}`, name);
		}
		function Bar({ width }: { width: number }) {
			return (
				<div style={{ width }} className="flex items-center gap-1.5">
					<h1 data-presence-yields="" className="min-w-0 truncate">
						A long entry title that gives up its width first
					</h1>
					<PresenceAvatars room={fake.room} fieldLabel={fieldLabel} />
				</div>
			);
		}
		const screen = await render(<Bar width={400} />);
		const circles = () =>
			screen
				.getByRole("button")
				.elements()
				.map((button) => button.textContent);
		const row = () => screen.container.firstElementChild!;

		await expect.poll(circles).toEqual(["AL", "BO", "CP", "+2"]);
		await screen.rerender(<Bar width={64} />);
		await expect.poll(circles).toEqual(["AL", "+4"]);
		expect(row().scrollWidth).toBeLessThanOrEqual(row().clientWidth);
		await screen.rerender(<Bar width={44} />);
		await expect.poll(circles).toEqual(["5"]);
		await expect
			.element(screen.getByRole("button", { name: "Show the 5 people here" }))
			.toBeVisible();
		await screen.rerender(<Bar width={30} />);
		await expect.poll(circles).toEqual([]);
		expect(row().scrollWidth).toBeLessThanOrEqual(row().clientWidth);
		const everyone = screen.getByRole("group", { name: "5 other people here" });
		await expect.element(everyone).toHaveTextContent("Ana Lima · Viewing");
		await expect.element(everyone).toHaveTextContent("Eli Cohen · Viewing");
	});

	it("lets a person who leaves fade out, and removes them at once under reduced motion", async () => {
		const fake = createRoom({});
		fake.present("u-ana", "Ana Lima");
		fake.present("u-ben", "Ben Okafor");
		const screen = await render(<PresenceAvatars room={fake.room} fieldLabel={fieldLabel} />);
		const ben = () => screen.container.querySelector('[aria-label="Ben Okafor · Viewing"]');
		await expect.poll(ben).not.toBeNull();

		fake.leave("u-ben");
		await expect.poll(() => ben()?.getAttribute("aria-hidden")).toBe("true");
		expect(getComputedStyle(ben()!).transitionProperty).toBe("transform, scale, opacity");
		await expect.poll(ben).toBeNull();

		await reduceMotion(true);
		fake.present("u-ben", "Ben Okafor");
		await expect.poll(ben).not.toBeNull();
		expect(getComputedStyle(ben()!).transitionProperty).toBe("none");
		fake.leave("u-ben");
		await settle();
		expect(ben()).toBeNull();
	});

	it("shows a person's photo when the admin has it, and their initials without one or when it doesn't load", async () => {
		const fake = createRoom({});
		fake.present("u-ana", "Ana Lima", "title");
		fake.present("u-ben", "Ben Okafor");
		fake.present("u-cleo", "Cleo Park");
		fake.present("u-dev", "Dev Iyer");
		const photos = new Map([
			["u-ana", PHOTO],
			["u-cleo", "/no-such-photo.png"],
			["u-dev", PHOTO],
		]);
		const screen = await render(
			<PresenceAvatars room={fake.room} fieldLabel={fieldLabel} photos={photos} />,
		);
		const loaded = (image: HTMLImageElement | null) =>
			Boolean(image?.complete && image.naturalWidth);

		const ana = screen.getByRole("button", { name: "Ana Lima · Editing Title" }).element();
		await expect.poll(() => loaded(ana.querySelector("img"))).toBe(true);
		const photo = ana.querySelector("img")!;
		expect(photo.alt).toBe("");
		expect(photo.loading).toBe("lazy");
		expect(photo.decoding).toBe("async");
		expect(getComputedStyle(photo).objectFit).toBe("cover");
		expect(ana.textContent).toBe("");
		await expect
			.element(screen.getByRole("button", { name: "Ben Okafor · Viewing" }))
			.toHaveTextContent("BO");
		const cleo = screen.getByRole("button", { name: "Cleo Park · Viewing" });
		await expect.element(cleo).toHaveTextContent("CP");
		expect(cleo.element().querySelector("img")).toBeNull();

		await screen.getByRole("button", { name: "Show 1 more person" }).click();
		const list = page.getByRole("dialog", { name: "People in this entry" });
		await expect.element(list).toBeVisible();
		const rows = list.getByRole("listitem").elements();
		await expect
			.poll(() => rows.map((row) => loaded(row.querySelector("img"))))
			.toEqual([true, false, false, true]);
		await expect
			.poll(() => rows.map((row) => row.textContent))
			.toEqual([
				"Ana LimaEditing Title",
				"BOBen OkaforViewing",
				"CPCleo ParkViewing",
				"Dev IyerViewing",
			]);
	});

	it.each(["ltr", "rtl"])(
		"overlaps each circle over the one before it by about a quarter (%s)",
		async (dir) => {
			const fake = createRoom({});
			for (const name of ["Ana Lima", "Ben Okafor", "Cleo Park", "Dev Iyer"]) {
				fake.present(`u-${name}`, name);
			}
			const screen = await render(
				<div dir={dir}>
					<PresenceAvatars room={fake.room} fieldLabel={fieldLabel} />
				</div>,
			);
			await expect.poll(() => faces(screen.container).length).toBe(4);
			const all = faces(screen.container);
			for (let index = 1; index < all.length; index++) {
				const before = all[index - 1]!.getBoundingClientRect();
				const face = all[index]!.getBoundingClientRect();
				const overlap = dir === "ltr" ? before.right - face.left : face.right - before.left;
				expect(overlap / face.width).toBeCloseTo(0.25, 1);
				const x = dir === "ltr" ? face.left + overlap / 2 : face.right - overlap / 2;
				const top = document.elementFromPoint(x, face.top + face.height / 2);
				expect(top?.closest("[data-presence-face]")).toBe(all[index]);
			}
		},
	);

	it("lifts the circle under the pointer, and its neighbors less the further they are, without moving anything", async () => {
		const fake = createRoom({});
		for (const name of ["Ana Lima", "Ben Okafor", "Cleo Park", "Dev Iyer", "Eli Cohen"]) {
			fake.present(`u-${name}`, name);
		}
		const screen = await render(
			<>
				<PresenceAvatars room={fake.room} fieldLabel={fieldLabel} />
				<p>Elsewhere</p>
			</>,
		);
		await expect.poll(() => faces(screen.container).length).toBe(4);
		const [ana, , , more] = faces(screen.container);
		const layout = () => [
			screen.getByRole("group").element().getBoundingClientRect().toJSON(),
			...faces(screen.container).map((face) => [face.offsetLeft, face.offsetTop]),
		];
		const atRest = layout();

		await userEvent.hover(ana!);
		expect(lifts(screen.container)).toEqual([
			["-4px", "1.05"],
			["-1.8px", "1"],
			["-0.81px", "1"],
			["-0.36px", "1"],
		]);
		expect(getComputedStyle(ana!).transitionTimingFunction).toMatch(
			/^cubic-bezier\(0\.22, 1, 0\.36, 1\)/,
		);
		await expect
			.poll(() => getComputedStyle(ana!).transform)
			.toBe("matrix(1.05, 0, 0, 1.05, 0, -4)");
		expect(layout()).toEqual(atRest);

		await userEvent.hover(more!);
		expect(lifts(screen.container)).toEqual([
			["-0.36px", "1"],
			["-0.81px", "1"],
			["-1.8px", "1"],
			["-4px", "1.05"],
		]);

		await userEvent.hover(screen.getByText("Elsewhere").element());
		expect(lifts(screen.container)).toEqual(Array.from({ length: 4 }, () => ["0px", "1"]));
		expect(getComputedStyle(ana!).transitionTimingFunction).toMatch(
			/^cubic-bezier\(0\.34, 3\.85, 0\.64, 1\)/,
		);
		await expect.poll(() => getComputedStyle(more!).transform).toBe("matrix(1, 0, 0, 1, 0, 0)");
		expect(layout()).toEqual(atRest);
	});

	it("lifts a circle focused from the keyboard as it does one under the pointer, and not one clicked", async () => {
		const fake = createRoom({});
		for (const name of ["Ana Lima", "Ben Okafor", "Cleo Park"]) fake.present(`u-${name}`, name);
		const screen = await render(
			<>
				<button type="button">Before</button>
				<PresenceAvatars room={fake.room} fieldLabel={fieldLabel} />
				<p>Elsewhere</p>
			</>,
		);
		await expect.poll(() => faces(screen.container).length).toBe(3);
		const rest = Array.from({ length: 3 }, () => ["0px", "1"]);

		screen.getByRole("button", { name: "Before" }).element().focus();
		await userEvent.tab();
		expect(lifts(screen.container)).toEqual([
			["-4px", "1.05"],
			["-1.8px", "1"],
			["-0.81px", "1"],
		]);
		await userEvent.tab();
		expect(lifts(screen.container)).toEqual([
			["-1.8px", "1"],
			["-4px", "1.05"],
			["-1.8px", "1"],
		]);
		await userEvent.tab({ shift: true });
		await userEvent.tab({ shift: true });
		expect(document.activeElement).toBe(screen.getByRole("button", { name: "Before" }).element());
		expect(lifts(screen.container)).toEqual(rest);

		await screen.getByRole("button", { name: "Cleo Park · Viewing" }).click({ force: true });
		await userEvent.hover(screen.getByText("Elsewhere").element());
		expect(lifts(screen.container)).toEqual(rest);
	});

	it("doesn't move the circles under reduced motion", async () => {
		await reduceMotion(true);
		const fake = createRoom({});
		fake.present("u-ana", "Ana Lima");
		fake.present("u-ben", "Ben Okafor");
		const screen = await render(<PresenceAvatars room={fake.room} fieldLabel={fieldLabel} />);
		await expect.poll(() => faces(screen.container).length).toBe(2);
		const [ana] = faces(screen.container);

		await userEvent.hover(ana!);
		expect(lifts(screen.container)[0]).toEqual(["-4px", "1.05"]);
		expect(getComputedStyle(ana!).transform).toBe("none");
		expect(getComputedStyle(ana!).transitionProperty).toBe("none");
	});
});

describe("field presence", () => {
	it("shows a person's name on a field while they are in it, and never a viewer's", async () => {
		const room = new LoopbackRoom();
		const a = await join(room);
		const b = await join(room);
		room.access = "view";
		const viewer = await join(room);
		await render(
			<>
				<Editor room={a.editing} fields={["title", "excerpt"]} />
				<Editor room={b.editing} fields={["title", "excerpt"]} />
				<Editor room={viewer.editing} fields={["title", "excerpt"]} />
				<PresenceAvatars room={a.editing} fieldLabel={fieldLabel} />
			</>,
		);
		const pills = (field: string) =>
			Array.from(
				document.querySelectorAll(
					`[data-co-editing-room="${a.editing.id}"] [data-co-editing-field="${field}"] .emdash-presence-pill`,
				),
				(pill) => pill.textContent,
			);

		page
			.getByRole("textbox", { name: `Title of ${b.editing.id}` })
			.element()
			.focus();

		await expect.poll(() => pills("title")).toEqual([userName(b)]);
		await expect
			.element(page.getByRole("button", { name: `${userName(b)} · Editing Title` }))
			.toBeVisible();

		page
			.getByRole("textbox", { name: `Excerpt of ${viewer.editing.id}` })
			.element()
			.focus();

		await expect.poll(() => pills("title")).toEqual([]);
		await expect
			.element(page.getByRole("button", { name: `${userName(b)} · Viewing` }))
			.toBeVisible();
		expect(viewer.replica().awareness.getLocalState()?.field).toBe("excerpt");
		await expect
			.element(page.getByRole("button", { name: `${userName(viewer)} · Viewing` }))
			.toBeVisible();
		expect(pills("excerpt")).toEqual([]);
	});

	it("sits at the inline end of the label row, in either direction, and shows two names then +N", async () => {
		const fake = createRoom({});
		fake.present("u-ana", "Ana Lima", "title");
		fake.present("u-ben", "Ben Okafor", "title");
		fake.present("u-cleo", "Cleo Park", "title");
		const screen = await render(
			<>
				<div dir="ltr">
					<Editor room={fake.room} fields={["title"]} />
				</div>
				<div dir="rtl">
					<Editor room={fake.room} fields={["title"]} />
				</div>
			</>,
			{ container: adminRoot() },
		);
		await expect
			.poll(() => screen.container.querySelectorAll(".emdash-presence-pill").length)
			.toBe(6);
		for (const dir of ["ltr", "rtl"]) {
			const field = screen.container.querySelector(`[dir=${dir}] [data-co-editing-field]`)!;
			const pills = [...field.querySelectorAll(".emdash-presence-pill")];
			expect(pills.map((pill) => pill.textContent)).toEqual(["Ana Lima", "Ben Okafor", "+1"]);
			const box = field.getBoundingClientRect();
			const row = pills.map((pill) => pill.getBoundingClientRect());
			const label = field.querySelector("label")!.getBoundingClientRect();
			if (dir === "ltr")
				expect(Math.max(...row.map((rect) => rect.right))).toBeCloseTo(box.right, 0);
			else expect(Math.min(...row.map((rect) => rect.left))).toBeCloseTo(box.left, 0);
			// Floats over the label row, so the field below it doesn't move.
			for (const rect of row) {
				expect(rect.height).toBe(18);
				expect(rect.top).toBeGreaterThanOrEqual(label.top);
			}
		}
	});
});

describe("re-rendering", () => {
	it("doesn't render the avatars again when the pointer or keyboard focus lifts them and leaves", async () => {
		const fake = createRoom({});
		for (const [name, field] of [
			["Ana Lima", "title"],
			["Ben Okafor", "excerpt"],
			["Cleo Park", "body"],
			["Dev Iyer", "title"],
		] as const) {
			fake.present(`u-${name}`, name, field);
		}
		// Each render names every person's field. Kumo's tooltips render on their own as the
		// pointer crosses them, which a Profiler around the avatars would count too.
		const label = vi.fn(fieldLabel);
		const screen = await render(
			<>
				<button type="button">Before</button>
				<PresenceAvatars room={fake.room} fieldLabel={label} />
				<p>Elsewhere</p>
			</>,
		);
		await expect.poll(() => faces(screen.container).length).toBe(4);
		await settle();
		label.mockClear();
		const [ana, , cleo, more] = faces(screen.container);
		const elsewhere = screen.getByText("Elsewhere").element();
		const lifted = () => lifts(screen.container).findIndex(([shift]) => shift === "-4px");

		for (const [index, face] of [ana!, cleo!, more!].entries()) {
			// oxlint-disable-next-line no-await-in-loop -- one pointer, moved in turn
			await userEvent.hover(face);
			expect(lifted()).toBe([0, 2, 3][index]);
		}
		await userEvent.hover(elsewhere);
		expect(lifted()).toBe(-1);
		screen.getByRole("button", { name: "Before" }).element().focus();
		await userEvent.tab();
		await userEvent.tab();
		expect(lifted()).toBe(1);
		await userEvent.tab({ shift: true });
		await userEvent.tab({ shift: true });
		expect(lifted()).toBe(-1);
		await settle();
		expect(label).not.toHaveBeenCalled();
	});

	it("re-renders nothing when a cursor moves, and only the avatars and the two fields when someone changes field", async () => {
		await reduceMotion(true);
		const room = new LoopbackRoom();
		const a = await join(room);
		const b = await join(room);
		const renders = new Map<string, number>();
		const count = (id: string) => () => renders.set(id, (renders.get(id) ?? 0) + 1);
		await render(
			<>
				<React.Profiler id="avatars" onRender={count("avatars")}>
					<PresenceAvatars room={a.editing} fieldLabel={fieldLabel} />
				</React.Profiler>
				{["title", "excerpt", "body"].map((field) => (
					<React.Profiler key={field} id={field} onRender={count(field)}>
						<FieldPresence room={a.editing} field={field} />
					</React.Profiler>
				))}
			</>,
		);
		const awareness = b.replica().awareness;
		awareness.setLocalStateField("field", "title");
		await expect
			.element(page.getByRole("button", { name: `${userName(b)} · Editing Title` }))
			.toBeVisible();
		await settle();
		const before = new Map(renders);
		const since = () =>
			Object.fromEntries(
				["avatars", "title", "excerpt", "body"].map((id) => [
					id,
					(renders.get(id) ?? 0) - (before.get(id) ?? 0),
				]),
			);

		for (let step = 1; step <= 5; step++) {
			awareness.setLocalStateField("cursor", {
				anchor: { type: null, tname: "field:body", item: { client: 1, clock: step }, assoc: 0 },
				head: { type: null, tname: "field:body", item: { client: 1, clock: step }, assoc: 0 },
			});
			// oxlint-disable-next-line no-await-in-loop -- each move reaches A on its own
			await settle();
		}
		expect(since()).toEqual({ avatars: 0, title: 0, excerpt: 0, body: 0 });

		awareness.setLocalStateField("field", "excerpt");
		await expect
			.element(page.getByRole("button", { name: `${userName(b)} · Editing Excerpt` }))
			.toBeVisible();
		await settle();
		expect(since()).toEqual({ avatars: 1, title: 1, excerpt: 1, body: 0 });
	});
});
