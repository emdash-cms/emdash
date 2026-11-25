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

/**
 * A map-backed forms collection with plugin storage's write semantics: `put` is an upsert of the
 * whole record, `updateIf` merges fields into an existing record and never inserts.
 */
function formsCollection(stored: Forms) {
	return {
		get: async (id: string) => structuredClone(stored.get(id) ?? null),
		put: async (id: string, value: FormDefinition) => void stored.set(id, value),
		updateIf: async (id: string, args: { set: Partial<FormDefinition> }) => {
			const existing = stored.get(id);
			if (!existing) return { applied: false };
			const data = { ...existing, ...args.set };
			stored.set(id, data);
			return { applied: true, data };
		},
		query: async () => ({
			items: Array.from(stored, ([id, data]) => ({ id, data: structuredClone(data) })),
		}),
	};
}

const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

/**
 * Each handler reads the form, awaits other work, then updates the form's counters.
 * `meanwhile` runs during that await, standing in for an admin request saved concurrently.
 */
const handlers = {
	submit: async (stored: Forms, meanwhile: (forms: Forms) => void) => {
		const ctx = {
			input: submitSchema.parse({
				formId: "apply",
				data: {},
				files: { cv: { filename: "cv.png", contentType: "image/png", bytes: [1, 2, 3] } },
			}),
			storage: {
				forms: formsCollection(stored),
				submissions: { put: async () => {}, count: async () => 6 },
			},
			kv: { get: async () => null },
			log: log(),
			media: {
				upload: async () => {
					meanwhile(stored);
					return { mediaId: "m1", storageKey: "k1", url: "/k1" };
				},
			},
			requestMeta: { ip: "203.0.113.1", userAgent: "test", referer: null, headers: {} },
		};
		await submitHandler(ctx as never);
	},

	"submissions/delete": async (stored: Forms, meanwhile: (forms: Forms) => void) => {
		const ctx = {
			input: { id: "sub-1" },
			storage: {
				forms: formsCollection(stored),
				submissions: {
					get: async () => ({ formId: "apply" }),
					delete: async () => true,
					count: async () => {
						meanwhile(stored);
						return 6;
					},
				},
			},
		};
		await submissionDeleteHandler(ctx as never);
	},

	cleanup: async (stored: Forms, meanwhile: (forms: Forms) => void) => {
		const ctx = {
			storage: {
				forms: formsCollection(stored),
				submissions: {
					query: async () => ({ items: [{ id: "sub-1", data: {} }] }),
					deleteMany: async (ids: string[]) => {
						meanwhile(stored);
						return ids.length;
					},
					count: async () => 6,
				},
			},
			log: log(),
		};
		await handleCleanup(ctx as never);
	},
};

describe.each(Object.entries(handlers))("%s while the form is changed", (_name, run) => {
	it("updates the counter and keeps the concurrent edit", async () => {
		const stored: Forms = new Map([["apply", form()]]);

		await run(stored, pauseAndEdit);

		const after = stored.get("apply")!;
		expect(after.status).toBe("paused");
		expect(after.settings.notifyEmails).toEqual(["new@example.com"]);
		expect(after.submissionCount).toBe(6);
	});

	it("does not recreate a form deleted in the meantime", async () => {
		const stored: Forms = new Map([["apply", form()]]);

		await run(stored, remove);

		expect(stored.has("apply")).toBe(false);
	});
});

it("records when the last submission was received", async () => {
	const stored: Forms = new Map([["apply", form()]]);

	await handlers.submit(stored, () => {});

	expect(stored.get("apply")!.lastSubmissionAt).toEqual(expect.any(String));
});
