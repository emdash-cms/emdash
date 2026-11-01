import { describe, it, expect, vi, beforeEach } from "vitest";
import { userEvent } from "vitest/browser";

import { EntryLockNotice } from "../../src/components/EntryLockNotice";
import { ApiResponseError } from "../../src/lib/api/client";
import {
	entryLockRefusal,
	type EntryLockHolder,
	type EntryLockStatus,
} from "../../src/lib/api/entry-lock";
import { useEntryLock } from "../../src/lib/useEntryLock";
import { render } from "../utils/render.tsx";

const acquireEntryLock = vi.fn<(...args: unknown[]) => Promise<EntryLockStatus>>();

vi.mock("../../src/lib/api/entry-lock.js", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../../src/lib/api/entry-lock.js")>();
	return {
		...actual,
		acquireEntryLock: (...args: unknown[]) => acquireEntryLock(...args),
		releaseEntryLock: async () => {},
	};
});

function holder(overrides: Partial<EntryLockHolder> = {}): EntryLockHolder {
	return {
		userId: "user-ada",
		userName: "Ada",
		acquiredAt: "2026-09-04T10:00:00.000Z",
		expiresAt: "2026-09-04T10:07:00.000Z",
		...overrides,
	};
}

describe("EntryLockNotice", () => {
	it("names the holder and offers both ways forward", async () => {
		const onTakeOver = vi.fn();
		const onReadInstead = vi.fn();
		const screen = await render(
			<EntryLockNotice
				state={{ status: "blocked", holder: holder() }}
				onTakeOver={onTakeOver}
				onReadInstead={onReadInstead}
				isTakingOver={false}
			/>,
		);

		await expect.element(screen.getByText("Ada", { exact: false })).toBeInTheDocument();
		// The dialog backdrop swallows synthetic pointer events, so the button is
		// driven directly.
		screen.getByRole("button", { name: "Open read-only" }).element().click();

		await vi.waitFor(() => {
			expect(onReadInstead).toHaveBeenCalledTimes(1);
		});
		expect(onTakeOver).not.toHaveBeenCalled();
	});

	it("falls back to a neutral label when the holder has no display name", async () => {
		const screen = await render(
			<EntryLockNotice
				state={{ status: "blocked", holder: holder({ userName: null }) }}
				onTakeOver={vi.fn()}
				onReadInstead={vi.fn()}
				isTakingOver={false}
			/>,
		);

		await expect.element(screen.getByText("Another editor", { exact: false })).toBeInTheDocument();
	});

	it("tells the previous holder their edits stopped being saved", async () => {
		const onTakeOver = vi.fn();
		const screen = await render(
			<EntryLockNotice
				state={{ status: "taken", holder: holder({ userName: "Grace" }) }}
				onTakeOver={onTakeOver}
				onReadInstead={vi.fn()}
				isTakingOver={false}
			/>,
		);

		await expect.element(screen.getByText("You no longer hold this entry")).toBeInTheDocument();
		await screen.getByRole("button", { name: "Take over" }).click();
		expect(onTakeOver).toHaveBeenCalledTimes(1);
	});

	it("renders nothing while this session holds the entry", async () => {
		const screen = await render(
			<EntryLockNotice
				state={{ status: "holding" }}
				onTakeOver={vi.fn()}
				onReadInstead={vi.fn()}
				isTakingOver={false}
			/>,
		);

		expect(screen.container.textContent).toBe("");
	});
});

describe("EntryLockNotice taking over", () => {
	const HELD_BY_ADA: EntryLockStatus = { enabled: true, heldByCaller: false, holder: holder() };

	function LockedEditor() {
		const lock = useEntryLock({ collection: "posts", entryId: "entry-1", ready: true });
		return (
			<EntryLockNotice
				state={lock.state}
				onTakeOver={lock.takeOver}
				onReadInstead={lock.readInstead}
				isTakingOver={lock.isTakingOver}
				takeOverFailed={lock.takeOverFailed}
			/>
		);
	}

	beforeEach(() => {
		acquireEntryLock.mockReset();
	});

	it("stays up and says so when the take-over fails", async () => {
		acquireEntryLock.mockResolvedValueOnce(HELD_BY_ADA).mockRejectedValueOnce(new Error("offline"));
		const screen = await render(<LockedEditor />);
		const dialog = screen.getByRole("alertdialog", { name: "This entry is open somewhere else" });
		await expect.element(dialog).toBeVisible();

		dialog.getByRole("button", { name: "Take over" }).element().click();

		await expect
			.element(dialog.getByRole("alert"))
			.toHaveTextContent("Couldn’t take over this entry. Try again.");
		await expect.element(dialog.getByRole("button", { name: "Take over" })).toBeEnabled();
		await expect
			.element(dialog)
			.toHaveAccessibleDescription(
				"Ada is editing this entry. Open it read-only, or take over; they will be told the entry moved on.",
			);
	});

	it("can't be dismissed while the take-over runs", async () => {
		acquireEntryLock
			.mockResolvedValueOnce(HELD_BY_ADA)
			.mockReturnValueOnce(new Promise<EntryLockStatus>(() => {}));
		const screen = await render(<LockedEditor />);
		const dialog = screen.getByRole("alertdialog", { name: "This entry is open somewhere else" });
		await expect.element(dialog).toBeVisible();

		dialog.getByRole("button", { name: "Take over" }).element().click();
		await expect.element(dialog.getByRole("button", { name: "Taking over..." })).toBeDisabled();
		await expect.element(dialog.getByRole("button", { name: "Open read-only" })).toBeDisabled();
		await userEvent.keyboard("{Escape}");

		await expect.element(dialog).toBeVisible();
		expect(screen.getByText("Read-only", { exact: true }).query()).toBeNull();
	});
});

describe("entryLockRefusal", () => {
	it("reads the holder out of a refused write", () => {
		const error = new ApiResponseError(409, "ENTRY_LOCKED", "Another editor is holding this", {
			userId: "user-ada",
			userName: "Ada",
			acquiredAt: "2026-09-04T10:00:00.000Z",
			expiresAt: "2026-09-04T10:07:00.000Z",
		});

		expect(entryLockRefusal(error)).toEqual(holder());
	});

	it("ignores every other failure", () => {
		expect(entryLockRefusal(new ApiResponseError(409, "CONFLICT", "Version conflict"))).toBeNull();
		expect(entryLockRefusal(new Error("network"))).toBeNull();
		expect(entryLockRefusal(undefined)).toBeNull();
	});
});
