import { describe, expect, it, vi } from "vitest";

import { handleCleanup } from "../src/handlers/cron.js";
import { submissionDeleteHandler } from "../src/handlers/submissions.js";
import { submitHandler } from "../src/handlers/submit.js";
import { submitSchema } from "../src/schemas.js";
import type { FormDefinition } from "../src/types.js";

function form(): FormDefinition {
	return {
		name: "Apply",
		slug: "apply",
		status: "active",
		pages: [
			{
				fields: [
					{ id: "f1", name: "cv", label: "CV", type: "file", required: false, width: "full" },
				],
			},
		],
		submissionCount: 5,
		lastSubmissionAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		settings: {
			spamProtection: "none",
			notifyEmails: ["old@example.com"],
			digestEnabled: false,
			digestHour: 9,
			retentionDays: 30,
			submitLabel: "Send",
			confirmationMessage: "Thanks",
		},
	} as unknown as FormDefinition;
}

type Forms = Map<string, FormDefinition>;

function pauseAndEdit(forms: Forms) {
	const current = forms.get("apply")!;
	forms.set("apply", {
		...current,
		status: "paused",
		settings: { ...current.settings, notifyEmails: ["new@example.com"] },
	});
}

function remove(forms: Forms) {
	forms.delete("apply");
}

type Delta = { inc: number } | { dec: number };

/**
 * A map-backed forms collection with plugin storage's write semantics: `put` is an upsert of the
 * whole record, `updateIf` merges `set` and applies `delta` to an existing record and never
 * inserts. `meanwhile` stands in for an admin request saved while the handler is working: it runs
 * once, right after the handler's first read of the form, or before its first write if it never
 * reads the form.
 */
function formsCollection(stored: Forms, meanwhile: (forms: Forms) => void) {
	let pending: ((forms: Forms) => void) | null = meanwhile;
	const runPending = () => {
		pending?.(stored);
		pending = null;
	};
	const read = <T>(value: T): T => {
		const copy = structuredClone(value);
		runPending();
		return copy;
	};
	return {
		get: async (id: string) => read(stored.get(id) ?? null),
		put: async (id: string, value: FormDefinition) => {
			runPending();
			stored.set(id, value);
		},
		updateIf: async (
			id: string,
			args: { set?: Partial<FormDefinition>; delta?: Record<string, Delta> },
		) => {
			runPending();
			const existing = stored.get(id);
			if (!existing) return { applied: false };
			const data: Record<string, unknown> = { ...existing, ...args.set };
			for (const [field, d] of Object.entries(args.delta ?? {})) {
				const base = typeof data[field] === "number" ? (data[field] as number) : 0;
				data[field] = "inc" in d ? base + d.inc : base - d.dec;
			}
			stored.set(id, data as unknown as FormDefinition);
			return { applied: true, data };
		},
		query: async () => read({ items: Array.from(stored, ([id, data]) => ({ id, data })) }),
	};
}

const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

type Change = (forms: Forms) => void;

const handlers = {
	submit: async (stored: Forms, meanwhile: Change) => {
		const ctx = {
			input: submitSchema.parse({
				formId: "apply",
				data: {},
				files: { cv: { filename: "cv.png", contentType: "image/png", bytes: [1, 2, 3] } },
			}),
			storage: {
				forms: formsCollection(stored, meanwhile),
				submissions: { put: async () => {} },
			},
			kv: { get: async () => null },
			log: log(),
			media: { upload: async () => ({ mediaId: "m1", storageKey: "k1", url: "/k1" }) },
			requestMeta: { ip: "203.0.113.1", userAgent: "test", referer: null, headers: {} },
		};
		await submitHandler(ctx as never);
	},

	"submissions/delete": async (stored: Forms, meanwhile: Change) => {
		const ctx = {
			input: { id: "sub-1" },
			storage: {
				forms: formsCollection(stored, meanwhile),
				submissions: {
					get: async () => ({ formId: "apply" }),
					delete: async () => true,
					count: async () => 4,
				},
			},
		};
		await submissionDeleteHandler(ctx as never);
	},

	cleanup: async (stored: Forms, meanwhile: Change) => {
		const ctx = {
			storage: {
				forms: formsCollection(stored, meanwhile),
				submissions: {
					query: async () => ({ items: [{ id: "sub-1", data: {} }] }),
					deleteMany: async (ids: string[]) => ids.length,
					count: async () => 4,
				},
			},
			log: log(),
		};
		await handleCleanup(ctx as never);
	},
};

const expectedCount = { submit: 6, "submissions/delete": 4, cleanup: 4 };

describe.each(Object.entries(handlers))("%s while the form is changed", (name, run) => {
	it("updates the counter and keeps the concurrent edit", async () => {
		const stored: Forms = new Map([["apply", form()]]);

		await run(stored, pauseAndEdit);

		const after = stored.get("apply")!;
		expect(after.status).toBe("paused");
		expect(after.settings.notifyEmails).toEqual(["new@example.com"]);
		expect(after.submissionCount).toBe(expectedCount[name as keyof typeof expectedCount]);
	});

	it("does not recreate a form deleted in the meantime", async () => {
		const stored: Forms = new Map([["apply", form()]]);

		await run(stored, remove);

		expect(stored.has("apply")).toBe(false);
	});
});

it("counts every submission when several are recorded at once", async () => {
	const stored: Forms = new Map([["apply", form()]]);

	await Promise.all([1, 2, 3].map(() => handlers.submit(stored, () => {})));

	expect(stored.get("apply")!.submissionCount).toBe(8);
	expect(stored.get("apply")!.lastSubmissionAt).toEqual(expect.any(String));
});

it("leaves the counter alone when the submission was already gone", async () => {
	const stored: Forms = new Map([["apply", form()]]);
	const ctx = {
		input: { id: "sub-1" },
		storage: {
			forms: formsCollection(stored, () => {}),
			submissions: { get: async () => ({ formId: "apply" }), delete: async () => false },
		},
	};

	await submissionDeleteHandler(ctx as never);

	expect(stored.get("apply")!.submissionCount).toBe(5);
});
