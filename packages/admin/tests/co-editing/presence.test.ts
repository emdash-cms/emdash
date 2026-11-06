import { afterEach, describe, expect, it, vi } from "vitest";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";

import { Presence, trackFocusedField } from "../../src/lib/co-editing/replica/presence";

const awarenesses: Awareness[] = [];

afterEach(() => {
	for (const awareness of awarenesses.splice(0)) awareness.destroy();
	document.body.replaceChildren();
});

function tab(): Awareness {
	const awareness = new Awareness(new Y.Doc());
	awarenesses.push(awareness);
	return awareness;
}

/** Another tab, stamped with a user as the room stamps it, relayed to `to`. */
function peer(to: Awareness, user: string, field: string | null = null) {
	const awareness = tab();
	const relay = () =>
		applyAwarenessUpdate(to, encodeAwarenessUpdate(awareness, [awareness.clientID]), "room");
	awareness.setLocalState({ field, user: { id: user, name: user.replace("u-", "") } });
	relay();
	return {
		set(change: Record<string, unknown>) {
			awareness.setLocalState({ ...awareness.getLocalState(), ...change });
			relay();
		},
	};
}

function presence(self: string): { mine: Awareness; presence: Presence } {
	const mine = tab();
	const result = new Presence(mine);
	result.setSelf(self);
	return { mine, presence: result };
}

describe("presence", () => {
	it("lists each other person once, with a field from any of their tabs, and never this tab's user", () => {
		const { mine, presence: room } = presence("u-me");
		peer(mine, "u-ana");
		peer(mine, "u-ana", "title");
		peer(mine, "u-me", "body");
		peer(mine, "u-ben");

		expect(room.getUsers().map(({ id, field }) => ({ id, field }))).toEqual([
			{ id: "u-ana", field: "title" },
			{ id: "u-ben", field: null },
		]);
		expect(room.getUsers("title").map((user) => user.id)).toEqual(["u-ana"]);
		expect(room.getUsers("body")).toEqual([]);
	});

	it("gives each person the same color in every client, repeating colors past four people", () => {
		const people = ["u-ana", "u-ben", "u-cleo", "u-dev", "u-eli", "u-fay"];
		const views = people.map((self) => {
			const { mine, presence: room } = presence(self);
			for (const other of people) if (other !== self) peer(mine, other);
			return room;
		});

		for (const person of people) {
			const colors = views.map((room) => room.colorOf(person));
			expect(new Set(colors).size, person).toBe(1);
			for (const room of views) {
				const listed = room.getUsers().find((user) => user.id === person);
				if (listed) expect(listed.color).toBe(colors[0]);
			}
		}
		const firstFour = new Set(people.slice(0, 4).map((person) => views[0]!.colorOf(person)));
		expect(firstFour.size).toBe(4);
		expect([...firstFour]).not.toContain("neutral");
	});

	it("keeps its arrays while cursors move, and replaces only the fields someone left or entered", () => {
		const { mine, presence: room } = presence("u-me");
		const ana = peer(mine, "u-ana", "title");
		peer(mine, "u-ben", "body");
		const listener = vi.fn();
		room.subscribe(listener);
		const everyone = room.getUsers();
		const inBody = room.getUsers("body");

		ana.set({ cursor: { anchor: { item: { client: 1, clock: 4 } }, head: null } });
		ana.set({ cursor: { anchor: { item: { client: 1, clock: 9 } }, head: null } });

		expect(listener).not.toHaveBeenCalled();
		expect(room.getUsers()).toBe(everyone);

		ana.set({ field: "excerpt" });

		expect(listener).toHaveBeenCalledTimes(1);
		expect(room.getUsers()).not.toBe(everyone);
		expect(room.getUsers("title")).toEqual([]);
		expect(room.getUsers("excerpt").map((user) => user.id)).toEqual(["u-ana"]);
		expect(room.getUsers("body")).toBe(inBody);
	});
});

describe("the focused field", () => {
	function editor(roomId: string): HTMLInputElement {
		const root = document.createElement("div");
		root.setAttribute("data-co-editing-room", roomId);
		root.innerHTML = `<div data-co-editing-field="title"><input aria-label="Title"></div><button type="button">Save</button>`;
		document.body.append(root);
		return root.querySelector("input")!;
	}
	const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

	it("is the field that has focus in this room, and none once focus leaves it", async () => {
		const awareness = tab();
		awareness.setLocalState({ field: null });
		const title = editor("room-1");
		const otherRoom = editor("room-2");
		const stop = trackFocusedField(awareness, "room-1");

		title.focus();
		expect(awareness.getLocalState()?.field).toBe("title");

		title.closest("[data-co-editing-room]")!.querySelector("button")!.focus();
		await tick();
		expect(awareness.getLocalState()?.field).toBeNull();

		title.focus();
		otherRoom.focus();
		await tick();
		expect(awareness.getLocalState()?.field).toBeNull();

		stop();
		title.focus();
		expect(awareness.getLocalState()?.field).toBeNull();
	});
});
