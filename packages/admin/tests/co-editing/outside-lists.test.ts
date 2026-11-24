import { describe, expect, it } from "vitest";

import { ListSaver, rebaseList } from "../../src/lib/co-editing/outside-lists";

interface Credit {
	id: string;
	role: string | null;
}

const credit = (id: string, role: string | null = null): Credit => ({ id, role });
const options = {
	key: (item: Credit) => item.id,
	same: (a: Credit, b: Credit) => a.role === b.role,
};
const ids = (list: readonly Credit[]) => list.map((item) => item.id);

describe("rebaseList", () => {
	it("keeps what others added and drops what they removed, around this tab's change", () => {
		const base = [credit("a"), credit("b"), credit("c")];
		const mine = [credit("c"), credit("a"), credit("d")];
		const latest = [credit("a"), credit("x"), credit("c"), credit("y")];
		expect(ids(rebaseList(base, mine, latest, options))).toEqual(["c", "y", "a", "x", "d"]);
	});

	it("takes others' edits to items this tab left alone, and keeps its own", () => {
		const base = [credit("a"), credit("b")];
		const mine = [credit("a", "Editor"), credit("b")];
		const latest = [credit("a", "Writer"), credit("b", "Photos")];
		expect(rebaseList(base, mine, latest, options)).toEqual([
			credit("a", "Editor"),
			credit("b", "Photos"),
		]);
	});

	it("keeps an item missing from only the start of the list", () => {
		const base = [credit("a"), credit("b")];
		const mine = [credit("a"), credit("b"), credit("c")];
		expect(ids(rebaseList(base, mine, [credit("a")], options, false))).toEqual(["a", "b", "c"]);
		expect(ids(rebaseList(base, mine, [credit("a")], options, true))).toEqual(["a", "c"]);
	});
});

function deferred() {
	let resolve!: () => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<void>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

/** A list with a saver, against a server list that `server` holds. */
function harness(server: Credit[]) {
	let shown: Credit[] = [...server];
	const sent: Credit[][] = [];
	const replies: Array<ReturnType<typeof deferred>> = [];
	const settled: Array<Credit[] | null> = [];
	const saver = new ListSaver<Credit>({
		...options,
		shown: () => shown,
		save: async (build) => {
			const reply = deferred();
			replies.push(reply);
			await Promise.resolve();
			const list = build(server, true);
			sent.push(list);
			await reply.promise;
			server = list;
		},
		settled: (saved) => settled.push(saved),
	});
	return {
		saver,
		sent,
		replies,
		settled,
		change(next: Credit[]) {
			const before = shown;
			shown = next;
			saver.change(before);
		},
		setServer(list: Credit[]) {
			server = list;
		},
	};
}

const flush = () => new Promise((resolve) => setTimeout(resolve));

describe("ListSaver", () => {
	it("settles false after a failed save, and true once a retry sends it", async () => {
		const list = harness([credit("a")]);
		list.change([credit("a"), credit("b")]);
		const first = list.saver.whenSettled();
		await flush();
		list.replies[0]!.reject(new Error("Refused"));
		expect(await first).toBe(false);
		expect(list.saver.unsent).toBe(true);

		list.saver.retry();
		const second = list.saver.whenSettled();
		await flush();
		list.replies[1]!.resolve();
		expect(await second).toBe(true);
		expect(ids(list.sent[1]!)).toEqual(["a", "b"]);
		expect(list.saver.unsent).toBe(false);
	});

	it("keeps the rows past the start of the list in its base when it adopts only that start", async () => {
		const list = harness([credit("a"), credit("b"), credit("c")]);
		list.change([credit("a"), credit("b"), credit("c"), credit("d")]);
		await flush();
		list.replies[0]!.reject(new Error("Refused"));
		await flush();

		// A refetch shows only the list's first row, so the rest can't tell what changed.
		const shown = list.saver.adopt(
			[credit("a")],
			[credit("a"), credit("b"), credit("c"), credit("d")],
			false,
		);
		expect(ids(shown)).toEqual(["a", "b", "c", "d"]);
		// Another editor removes c, further down the list.
		list.setServer([credit("a"), credit("b")]);
		list.change([...shown, credit("e")]);
		await flush();
		list.replies[1]!.resolve();
		await flush();
		expect(list.sent.map(ids).at(-1)).toEqual(["a", "b", "d", "e"]);
	});

	it("sends one save at a time, the later change re-based on the earlier one", async () => {
		const list = harness([]);
		list.change([credit("a")]);
		list.change([credit("a"), credit("b")]);
		await flush();
		expect(list.sent.map(ids)).toEqual([["a"]]);

		list.replies[0]!.resolve();
		await flush();
		expect(list.sent.map(ids)).toEqual([["a"], ["a", "b"]]);
		list.replies[1]!.resolve();
		await flush();
		expect(list.settled.map((saved) => saved && ids(saved))).toEqual([["a", "b"]]);
	});

	it("keeps another tab's addition that landed after this tab read the list", async () => {
		const list = harness([credit("a")]);
		list.setServer([credit("a"), credit("x")]);
		list.change([credit("a"), credit("b")]);
		await flush();
		list.replies[0]!.resolve();
		await flush();
		expect(list.sent.map(ids)).toEqual([["a", "x", "b"]]);
		expect(list.settled.map((saved) => saved && ids(saved))).toEqual([["a", "x", "b"]]);
	});

	it("keeps a failed change unsent, shows the server's changes around it, and sends it with the next", async () => {
		const list = harness([credit("a")]);
		list.change([credit("a"), credit("b")]);
		await flush();
		list.replies[0]!.reject(new Error("Refused"));
		await flush();
		expect(list.settled).toEqual([null]);
		expect(list.saver.unsent).toBe(true);

		const shown = list.saver.adopt([credit("a"), credit("x")], [credit("a"), credit("b")]);
		expect(ids(shown)).toEqual(["a", "x", "b"]);
		list.setServer([credit("a"), credit("x")]);
		list.change([...shown, credit("c")]);
		await flush();
		list.replies[1]!.resolve();
		await flush();
		expect(list.sent.map(ids).at(-1)).toEqual(["a", "x", "b", "c"]);
		expect(list.saver.unsent).toBe(false);
		expect(ids(list.saver.adopt([credit("z")], shown))).toEqual(["z"]);
	});
});
