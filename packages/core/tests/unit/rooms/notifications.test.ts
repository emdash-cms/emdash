import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import {
	clearRoomNotifier,
	hasRoomNotifier,
	notifyRoom,
	setRoomNotifier,
	withRoomNotificationQueue,
} from "../../../src/rooms/notifications.js";
import { roomId } from "../../../src/rooms/types.js";
import { RecordingNotifier } from "../../utils/room-notifier.js";

const A = { collection: "posts", id: "01A" };
const B = { collection: "posts", id: "01B" };

/** A promise and the function that resolves it. */
function gate(): { opened: Promise<void>; open: () => void } {
	let open!: () => void;
	const opened = new Promise<void>((resolve) => (open = resolve));
	return { opened, open };
}

describe("room notifications", () => {
	let notifier: RecordingNotifier;

	beforeEach(() => {
		notifier = new RecordingNotifier();
		setRoomNotifier(notifier);
	});

	afterEach(() => {
		setRoomNotifier(null);
	});

	it("does nothing, and opens no queue, while no notifier is set", async () => {
		setRoomNotifier(null);

		await withRoomNotificationQueue(async () => {
			notifyRoom(A);
			expect(hasRoomNotifier()).toBe(false);
			setRoomNotifier(notifier);
			notifyRoom(B);
			await waitForDeferredTasks();
			expect(await notifier.rooms()).toEqual([[roomId(B), []]]);
		});
	});

	it("holds notifications until the queue ends, then sends one per room with the values merged", async () => {
		await withRoomNotificationQueue(async () => {
			notifyRoom(A, ["seo"]);
			notifyRoom(B);
			notifyRoom(A, ["terms", "seo"]);
			await withRoomNotificationQueue(async () => notifyRoom(B, ["bylines"]));
			await waitForDeferredTasks();
			expect(notifier.calls).toEqual([]);
		});

		expect(await notifier.rooms()).toEqual([
			[roomId(A), ["seo", "terms"]],
			[roomId(B), ["bylines"]],
		]);
	});

	it("sends when the queued work throws", async () => {
		await expect(
			withRoomNotificationQueue(async () => {
				notifyRoom(A);
				throw new Error("Refused");
			}),
		).rejects.toThrow("Refused");

		expect(await notifier.rooms()).toEqual([[roomId(A), []]]);
	});

	it("drops the skipped room's notifications only while its queue is open", async () => {
		const closed = gate();
		let deferred: Promise<void> | undefined;

		await withRoomNotificationQueue(
			async () => {
				notifyRoom(A, ["seo"]);
				notifyRoom(B);
				deferred = closed.opened.then(() => notifyRoom(A, ["terms"]));
			},
			{ skip: roomId(A) },
		);
		expect(await notifier.rooms()).toEqual([[roomId(B), []]]);

		closed.open();
		await deferred;
		expect(await notifier.rooms()).toEqual([[roomId(A), ["terms"]]]);
	});

	it("hands a skipping queue's notifications to the open queue around it", async () => {
		const innerClosed = gate();
		let deferred: Promise<void> | undefined;

		await withRoomNotificationQueue(async () => {
			notifyRoom(A, ["seo"]);
			await withRoomNotificationQueue(
				async () => {
					notifyRoom(A, ["terms"]);
					notifyRoom(B);
					deferred = innerClosed.opened.then(() => notifyRoom(A, ["bylines"]));
				},
				{ skip: roomId(A) },
			);
			innerClosed.open();
			await deferred;
			await waitForDeferredTasks();
			expect(notifier.calls).toEqual([]);
		});

		expect(await notifier.rooms()).toEqual([
			[roomId(A), ["bylines", "seo"]],
			[roomId(B), []],
		]);
	});

	it("keeps a newer notifier when an older one is cleared", async () => {
		const newer = new RecordingNotifier();
		setRoomNotifier(newer);

		clearRoomNotifier(notifier);
		notifyRoom(A);

		expect(await newer.rooms()).toEqual([[roomId(A), []]]);
		clearRoomNotifier(newer);
		expect(hasRoomNotifier()).toBe(false);
	});
});
