import { expect, it } from "vitest";

import { createPrimaryD1Session } from "../../src/db/d1-primary-session.js";

it("does not replace a later operation's bookmark with an earlier delayed result", async () => {
	let releaseFirst!: () => void;
	const firstReleased = new Promise<void>((resolve) => (releaseFirst = resolve));
	let operations = 0;
	const result = { success: true, results: [], meta: { changes: 0, last_row_id: 0 } };
	const binding = {
		withSession() {
			const operation = ++operations;
			const statement = {
				bind: () => statement,
				async all() {
					if (operation === 1) await firstReleased;
					return result;
				},
			};
			return {
				prepare: () => statement,
				batch: async (statements: Array<typeof statement>) =>
					Promise.all(statements.map((item) => item.all())),
				getBookmark: () => `bookmark-${operation}`,
			};
		},
	};
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- minimal D1 transport surface exercised by the session wrapper
	const session = createPrimaryD1Session(binding as unknown as D1Database);
	const first = session.prepare("SELECT 1").all();
	try {
		await session.batch([session.prepare("SELECT 2")]);
		expect(session.getBookmark()).toBe("bookmark-2");
		releaseFirst();
		await first;
		expect(session.getBookmark()).toBe("bookmark-2");
	} finally {
		releaseFirst();
		await first;
	}
});
