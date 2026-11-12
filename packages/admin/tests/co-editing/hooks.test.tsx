import { afterEach, expect, it, vi } from "vitest";
import { renderHook } from "vitest-browser-react";

import { ADMIN_BUILD } from "../../src/lib/admin-build";
import { joinRoom } from "../../src/lib/api/rooms";
import { useCoEditing } from "../../src/lib/co-editing/hooks";

vi.mock("../../src/lib/api/rooms", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/lib/api/rooms")>()),
	joinRoom: vi.fn(),
}));

const manifest = (hash: string) => ({
	version: "1.4.0",
	hash,
	collections: {
		posts: {
			label: "Posts",
			labelSingular: "Post",
			supports: ["revisions"],
			hasSeo: false,
			fields: { title: { kind: "string" }, body: { kind: "portableText" } },
		},
	},
	plugins: {},
});

afterEach(() => vi.mocked(joinRoom).mockReset());

it("keeps one session per entry, pinned to the manifest it started with", async () => {
	vi.mocked(joinRoom).mockResolvedValue({ kind: "locked" });
	const { result, rerender, act } = await renderHook(
		(props?: { hash: string; id: string }) =>
			useCoEditing({
				collection: "posts",
				entryId: props!.id,
				manifest: manifest(props!.hash) as never,
				onEvent: () => {},
			}),
		{ initialProps: { hash: "h1", id: "01A" } },
	);
	await expect.poll(() => result.current.mode).toBe("single-editor");
	await rerender({ hash: "h2", id: "01A" });
	const view = result.current;
	if (view.mode !== "single-editor") throw new Error("Expected single-editor mode");
	await act(() => view.takeOver(() => {}));
	await expect.poll(() => vi.mocked(joinRoom).mock.calls.length).toBe(2);
	await rerender({ hash: "h2", id: "01B" });
	await expect.poll(() => vi.mocked(joinRoom).mock.calls.length).toBe(3);
	expect(vi.mocked(joinRoom).mock.calls).toEqual([
		[
			{ collection: "posts", id: "01A", locale: undefined },
			{ fingerprint: { ...ADMIN_BUILD, hash: "h1" }, takeover: false, singleEditor: false },
		],
		[
			{ collection: "posts", id: "01A", locale: undefined },
			{ fingerprint: { ...ADMIN_BUILD, hash: "h1" }, takeover: true, singleEditor: false },
		],
		[
			{ collection: "posts", id: "01B", locale: undefined },
			{ fingerprint: { ...ADMIN_BUILD, hash: "h2" }, takeover: false, singleEditor: false },
		],
	]);
});

it("shows nothing of the previous entry's session once the entry changes", async () => {
	vi.mocked(joinRoom).mockResolvedValue({ kind: "locked" });
	const renders: { id: string; mode: string }[] = [];
	const { result, rerender } = await renderHook(
		(props?: { id: string }) => {
			const view = useCoEditing({
				collection: "posts",
				entryId: props!.id,
				manifest: manifest("h1") as never,
				onEvent: () => {},
			});
			renders.push({ id: props!.id, mode: view.mode });
			return view;
		},
		{ initialProps: { id: "01A" } },
	);
	await expect.poll(() => result.current.mode).toBe("single-editor");
	vi.mocked(joinRoom).mockReturnValue(new Promise(() => {}));

	await rerender({ id: "01B" });

	const afterSwitch = renders.filter((render) => render.id === "01B");
	expect(afterSwitch.length).toBeGreaterThan(0);
	expect(afterSwitch.filter((render) => render.mode !== "pending")).toEqual([]);
});
