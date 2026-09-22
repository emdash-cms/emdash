import * as React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { ApiResponseError } from "../../src/lib/api/client";
import type { EntryLockStatus } from "../../src/lib/api/entry-lock";
import { ENTRY_LOCK_HEARTBEAT_MS, useEntryLock } from "../../src/lib/useEntryLock";
import { render } from "../utils/render.tsx";

const acquireEntryLock = vi.fn<(...args: unknown[]) => Promise<EntryLockStatus>>();
const releaseEntryLock = vi.fn<(...args: unknown[]) => Promise<void>>();

vi.mock("../../src/lib/api/entry-lock.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/lib/api/entry-lock.js")>();
	return {
		...actual,
		acquireEntryLock: (...args: unknown[]) => acquireEntryLock(...args),
		releaseEntryLock: (...args: unknown[]) => releaseEntryLock(...args),
	};
});

const ADA = {
	userId: "user-ada",
	userName: "Ada",
	acquiredAt: "2026-09-04T10:00:00.000Z",
	expiresAt: "2026-09-04T10:07:00.000Z",
};

const GRANTED: EntryLockStatus = { enabled: true, heldByCaller: true, holder: ADA };
const HELD_BY_ADA: EntryLockStatus = { enabled: true, heldByCaller: false, holder: ADA };

/** Renders the hook's state so assertions read it out of the DOM. */
function Probe() {
	const lock = useEntryLock({ collection: "posts", entryId: "entry-1", ready: true });
	const [lastReport, setLastReport] = React.useState("");
	return (
		<div>
			<span data-testid="status">{lock.state.status}</span>
			<span data-testid="read-only">{String(lock.readOnly)}</span>
			<span data-testid="last-report">{lastReport}</span>
			<button type="button" onClick={lock.readInstead}>
				read instead
			</button>
			<button type="button" onClick={lock.takeOver}>
				take over
			</button>
			<button
				type="button"
				onClick={() =>
					setLastReport(
						String(
							lock.reportWriteError(
								new ApiResponseError(409, "ENTRY_LOCKED", "held", ADA),
								"entry-1",
							),
						),
					)
				}
			>
				report refusal
			</button>
			<button
				type="button"
				onClick={() =>
					setLastReport(
						String(
							lock.reportWriteError(new ApiResponseError(409, "CONFLICT", "stale"), "entry-1"),
						),
					)
				}
			>
				report conflict
			</button>
			<button
				type="button"
				onClick={() =>
					setLastReport(
						String(
							lock.reportWriteError(
								new ApiResponseError(409, "ENTRY_LOCKED", "held", ADA),
								"a-different-entry",
							),
						),
					)
				}
			>
				refusal for another entry
			</button>
		</div>
	);
}

function tokenOf(call: unknown[] | undefined): string | undefined {
	const options = call?.[2];
	return options && typeof options === "object" && "token" in options
		? (options as { token?: string }).token
		: undefined;
}

describe("useEntryLock", () => {
	beforeEach(() => {
		acquireEntryLock.mockReset();
		releaseEntryLock.mockReset();
		releaseEntryLock.mockResolvedValue(undefined);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("holds the entry when the lock is granted", async () => {
		acquireEntryLock.mockResolvedValue(GRANTED);

		const screen = await render(<Probe />);

		await expect.element(screen.getByTestId("status")).toHaveTextContent("holding");
		await expect.element(screen.getByTestId("read-only")).toHaveTextContent("false");
	});

	it("identifies its session with one token on acquire and release", async () => {
		acquireEntryLock.mockResolvedValue(GRANTED);

		const screen = await render(<Probe />);
		await expect.element(screen.getByTestId("status")).toHaveTextContent("holding");
		const token = tokenOf(acquireEntryLock.mock.calls[0]);
		expect(token).toEqual(expect.any(String));
		expect(token).not.toBe("");

		await screen.unmount();

		await vi.waitFor(() => {
			expect(releaseEntryLock).toHaveBeenCalledWith(
				"posts",
				"entry-1",
				expect.objectContaining({ token }),
			);
		});
	});

	it("blocks the editor when someone else holds it, until they choose to read", async () => {
		acquireEntryLock.mockResolvedValue(HELD_BY_ADA);

		const screen = await render(<Probe />);

		await expect.element(screen.getByTestId("status")).toHaveTextContent("blocked");
		await expect.element(screen.getByTestId("read-only")).toHaveTextContent("true");

		await screen.getByRole("button", { name: "read instead" }).click();
		await expect.element(screen.getByTestId("status")).toHaveTextContent("reading");
		await expect.element(screen.getByTestId("read-only")).toHaveTextContent("true");
	});

	it("asks for a take-over explicitly", async () => {
		acquireEntryLock.mockResolvedValueOnce(HELD_BY_ADA);
		acquireEntryLock.mockResolvedValueOnce({
			enabled: true,
			heldByCaller: true,
			holder: { ...ADA, userId: "user-me", userName: "Me" },
		});

		const screen = await render(<Probe />);
		await expect.element(screen.getByTestId("status")).toHaveTextContent("blocked");

		await screen.getByRole("button", { name: "take over" }).click();

		await expect.element(screen.getByTestId("status")).toHaveTextContent("holding");
		expect(acquireEntryLock).toHaveBeenLastCalledWith(
			"posts",
			"entry-1",
			expect.objectContaining({ takeover: true }),
		);
	});

	it("switches to read-only when a save is refused by someone else's lock", async () => {
		acquireEntryLock.mockResolvedValue(GRANTED);

		const screen = await render(<Probe />);
		await expect.element(screen.getByTestId("status")).toHaveTextContent("holding");

		await screen.getByRole("button", { name: "report refusal" }).click();

		await expect.element(screen.getByTestId("last-report")).toHaveTextContent("true");
		await expect.element(screen.getByTestId("status")).toHaveTextContent("taken");
		await expect.element(screen.getByTestId("read-only")).toHaveTextContent("true");
	});

	it("leaves every other failure to the caller's own error handling", async () => {
		acquireEntryLock.mockResolvedValue(GRANTED);

		const screen = await render(<Probe />);
		await expect.element(screen.getByTestId("status")).toHaveTextContent("holding");

		await screen.getByRole("button", { name: "report conflict" }).click();

		await expect.element(screen.getByTestId("last-report")).toHaveTextContent("false");
		await expect.element(screen.getByTestId("status")).toHaveTextContent("holding");
	});

	it("leaves a refusal for another entry to the caller as well", async () => {
		acquireEntryLock.mockResolvedValue(GRANTED);

		const screen = await render(<Probe />);
		await expect.element(screen.getByTestId("status")).toHaveTextContent("holding");

		await screen.getByRole("button", { name: "refusal for another entry" }).click();

		await expect.element(screen.getByTestId("last-report")).toHaveTextContent("false");
		await expect.element(screen.getByTestId("status")).toHaveTextContent("holding");
		await expect.element(screen.getByTestId("read-only")).toHaveTextContent("false");
	});

	it("takes no lock and stays editable when the collection has locking off", async () => {
		acquireEntryLock.mockResolvedValue({ enabled: false, heldByCaller: false, holder: null });

		const screen = await render(<Probe />);

		await expect.element(screen.getByTestId("status")).toHaveTextContent("disabled");
		await expect.element(screen.getByTestId("read-only")).toHaveTextContent("false");
	});

	it("hands the lock back on unmount, but only when it held one", async () => {
		acquireEntryLock.mockResolvedValue(GRANTED);
		const held = await render(<Probe />);
		await expect.element(held.getByTestId("status")).toHaveTextContent("holding");
		await held.unmount();
		await vi.waitFor(() => {
			expect(releaseEntryLock).toHaveBeenCalledTimes(1);
		});

		releaseEntryLock.mockClear();
		acquireEntryLock.mockResolvedValue(HELD_BY_ADA);
		const blocked = await render(<Probe />);
		await expect.element(blocked.getByTestId("status")).toHaveTextContent("blocked");
		await blocked.unmount();
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(releaseEntryLock).not.toHaveBeenCalled();
	});

	it("hands back a lock that was granted after the editor had already moved on", async () => {
		let grant: (status: EntryLockStatus) => void = () => {};
		acquireEntryLock.mockReturnValue(
			new Promise<EntryLockStatus>((resolve) => {
				grant = resolve;
			}),
		);

		const screen = await render(<Probe />);
		await expect.element(screen.getByTestId("status")).toHaveTextContent("pending");
		const token = tokenOf(acquireEntryLock.mock.calls[0]);
		await screen.unmount();
		expect(releaseEntryLock).not.toHaveBeenCalled();

		grant(GRANTED);

		await vi.waitFor(() => {
			expect(releaseEntryLock).toHaveBeenCalledWith(
				"posts",
				"entry-1",
				expect.objectContaining({ token }),
			);
		});
	});

	it("re-asserts the lease on a heartbeat and notices when it was lost", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		acquireEntryLock.mockResolvedValue(GRANTED);

		const screen = await render(<Probe />);
		await expect.element(screen.getByTestId("status")).toHaveTextContent("holding");
		expect(acquireEntryLock).toHaveBeenCalledTimes(1);

		await vi.advanceTimersByTimeAsync(ENTRY_LOCK_HEARTBEAT_MS + 100);
		expect(acquireEntryLock).toHaveBeenCalledTimes(2);
		expect(tokenOf(acquireEntryLock.mock.calls[1])).toBe(tokenOf(acquireEntryLock.mock.calls[0]));
		await expect.element(screen.getByTestId("status")).toHaveTextContent("holding");

		acquireEntryLock.mockResolvedValue(HELD_BY_ADA);
		await vi.advanceTimersByTimeAsync(ENTRY_LOCK_HEARTBEAT_MS + 100);

		await expect.element(screen.getByTestId("status")).toHaveTextContent("taken");
		await expect.element(screen.getByTestId("read-only")).toHaveTextContent("true");
	});

	it("opens the entry for editing once the holder has left", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		acquireEntryLock.mockResolvedValue(HELD_BY_ADA);

		const screen = await render(<Probe />);
		await expect.element(screen.getByTestId("status")).toHaveTextContent("blocked");
		await screen.getByRole("button", { name: "read instead" }).click();
		await expect.element(screen.getByTestId("status")).toHaveTextContent("reading");

		acquireEntryLock.mockResolvedValue(GRANTED);
		await vi.advanceTimersByTimeAsync(ENTRY_LOCK_HEARTBEAT_MS + 100);

		await expect.element(screen.getByTestId("status")).toHaveTextContent("holding");
		await expect.element(screen.getByTestId("read-only")).toHaveTextContent("false");
	});

	it("re-checks the lease as soon as the tab is looked at again", async () => {
		acquireEntryLock.mockResolvedValue(GRANTED);

		const screen = await render(<Probe />);
		await expect.element(screen.getByTestId("status")).toHaveTextContent("holding");
		expect(acquireEntryLock).toHaveBeenCalledTimes(1);

		Object.defineProperty(document, "visibilityState", { configurable: true, value: "visible" });
		try {
			document.dispatchEvent(new Event("visibilitychange"));
			await vi.waitFor(() => {
				expect(acquireEntryLock).toHaveBeenCalledTimes(2);
			});
		} finally {
			// eslint-disable-next-line @typescript-eslint/no-dynamic-delete -- restores the native getter
			delete (document as { visibilityState?: unknown }).visibilityState;
		}
	});

	it("hands the lock back with keepalive when the page is unloaded", async () => {
		acquireEntryLock.mockResolvedValue(GRANTED);

		const screen = await render(<Probe />);
		await expect.element(screen.getByTestId("status")).toHaveTextContent("holding");
		const token = tokenOf(acquireEntryLock.mock.calls[0]);

		window.dispatchEvent(new Event("pagehide"));

		await vi.waitFor(() => {
			expect(releaseEntryLock).toHaveBeenCalledWith(
				"posts",
				"entry-1",
				expect.objectContaining({ token, keepalive: true }),
			);
		});
	});

	it("keeps the editor open and keeps trying when the lock cannot be reached", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		acquireEntryLock.mockRejectedValueOnce(new Error("offline"));
		acquireEntryLock.mockResolvedValue(GRANTED);

		const screen = await render(<Probe />);
		await expect.element(screen.getByTestId("status")).toHaveTextContent("unreachable");
		await expect.element(screen.getByTestId("read-only")).toHaveTextContent("false");

		await vi.advanceTimersByTimeAsync(ENTRY_LOCK_HEARTBEAT_MS + 100);

		await expect.element(screen.getByTestId("status")).toHaveTextContent("holding");
	});
});
