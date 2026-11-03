import { describe, expect, it, vi } from "vitest";

import { digestTaskName, formIdFromDigestTask } from "../src/digest-task.js";
import {
	formsCreateHandler,
	formsDuplicateHandler,
	formsUpdateHandler,
} from "../src/handlers/forms.js";
import { formCreateSchema, formDuplicateSchema, formUpdateSchema } from "../src/schemas.js";
import type { FormDefinition } from "../src/types.js";

/** The rule `ctx.cron` applies to a task name (`validateTaskName` in core's `plugins/cron.ts`). */
const TASK_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

/** A plugin context whose cron refuses the names the real one refuses. */
function context(input: unknown, stored = new Map<string, FormDefinition>()) {
	const check = (name: string) => {
		if (!TASK_NAME_RE.test(name)) throw new Error(`Invalid task name "${name}"`);
	};
	const schedule = vi.fn(async (name: string, _opts: { schedule: string }) => check(name));
	const cancel = vi.fn(async (name: string) => check(name));
	const ctx = {
		input,
		storage: {
			forms: {
				get: async (id: string) => stored.get(id) ?? null,
				put: async (id: string, form: FormDefinition) => void stored.set(id, form),
				query: async () => ({ items: [] }),
			},
		},
		cron: { schedule, cancel },
	};
	return { ctx: ctx as never, schedule, cancel, stored };
}

const fields = [
	{ id: "f1", type: "text", label: "Email", name: "email", required: false, width: "full" },
];

describe("the daily digest's cron task", () => {
	it("is scheduled when a form is created with the digest on", async () => {
		const { ctx, schedule, stored } = context(
			formCreateSchema.parse({
				name: "Contact",
				slug: "contact",
				pages: [{ fields }],
				settings: { notifyEmails: ["editor@example.com"], digestEnabled: true, digestHour: 7 },
			}),
		);

		const created = await formsCreateHandler(ctx);

		expect(stored.has(created.id)).toBe(true);
		expect(schedule).toHaveBeenCalledWith(`digest-${created.id}`, { schedule: "0 7 * * *" });
	});

	it("is scheduled, moved and cancelled as an existing form's digest settings change", async () => {
		const first = context(
			formCreateSchema.parse({
				name: "Contact",
				slug: "contact",
				pages: [{ fields }],
				settings: {},
			}),
		);
		const { id } = await formsCreateHandler(first.ctx);
		expect(first.schedule).not.toHaveBeenCalled();

		const update = async (settings: Record<string, unknown>) => {
			const next = context(formUpdateSchema.parse({ id, settings }), first.stored);
			await formsUpdateHandler(next.ctx);
			return next;
		};

		const on = await update({ digestEnabled: true });
		expect(on.schedule).toHaveBeenCalledWith(`digest-${id}`, { schedule: "0 9 * * *" });

		const moved = await update({ digestHour: 18 });
		expect(moved.schedule).toHaveBeenCalledWith(`digest-${id}`, { schedule: "0 18 * * *" });

		const off = await update({ digestEnabled: false });
		expect(off.cancel).toHaveBeenCalledWith(`digest-${id}`);
	});

	it("is scheduled for a copy of a form with the digest on", async () => {
		const first = context(
			formCreateSchema.parse({
				name: "Contact",
				slug: "contact",
				pages: [{ fields }],
				settings: { digestEnabled: true, digestHour: 7 },
			}),
		);
		const { id } = await formsCreateHandler(first.ctx);

		const copy = context(formDuplicateSchema.parse({ id }), first.stored);
		const duplicated = await formsDuplicateHandler(copy.ctx);

		expect(duplicated.id).not.toBe(id);
		expect(copy.schedule).toHaveBeenCalledWith(`digest-${duplicated.id}`, {
			schedule: "0 7 * * *",
		});
	});

	it("has a name the plugin maps back to its form", () => {
		const name = digestTaskName("01M4C00952745BYW2ZD0KB1G0N");
		expect(name).toMatch(TASK_NAME_RE);
		expect(formIdFromDigestTask(name)).toBe("01M4C00952745BYW2ZD0KB1G0N");
		expect(formIdFromDigestTask("cleanup")).toBeNull();
	});
});
