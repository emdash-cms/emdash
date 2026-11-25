import type { Database, StorageCollection } from "emdash";
import { PluginStorageRepository } from "emdash";
import { createDialect } from "emdash/db/sqlite";
import { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleCleanup } from "../src/handlers/cron.js";
import { formsDeleteHandler, formsUpdateHandler } from "../src/handlers/forms.js";
import { submissionDeleteHandler } from "../src/handlers/submissions.js";
import { submitHandler } from "../src/handlers/submit.js";
import { formDeleteSchema, formUpdateSchema, submitSchema } from "../src/schemas.js";
import { FORMS_STORAGE_CONFIG } from "../src/storage.js";
import type { FormDefinition, Submission } from "../src/types.js";

function form(overrides: Partial<FormDefinition> = {}): FormDefinition {
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
		submissionCount: 0,
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
		...overrides,
	} as FormDefinition;
}

function submission(createdAt = new Date().toISOString()): Submission {
	return {
		formId: "apply",
		data: {},
		status: "new",
		starred: false,
		createdAt,
		meta: { ip: null, userAgent: null, referer: null, country: null },
	};
}

let db: Kysely<Database>;
let forms: StorageCollection<FormDefinition>;
let submissions: StorageCollection<Submission>;

beforeEach(async () => {
	db = new Kysely<Database>({ dialect: createDialect({ url: ":memory:" }) });
	await db.schema
		.createTable("_plugin_storage")
		.addColumn("plugin_id", "text", (col) => col.notNull())
		.addColumn("collection", "text", (col) => col.notNull())
		.addColumn("id", "text", (col) => col.notNull())
		.addColumn("data", "text", (col) => col.notNull())
		.addColumn("revision", "text", (col) => col.notNull().defaultTo("0"))
		.addColumn("created_at", "text")
		.addColumn("updated_at", "text")
		.addPrimaryKeyConstraint("pk_plugin_storage", ["plugin_id", "collection", "id"])
		.execute();
	forms = new PluginStorageRepository(db, "emdash-forms", "forms", [
		...FORMS_STORAGE_CONFIG.forms.indexes,
		...FORMS_STORAGE_CONFIG.forms.uniqueIndexes,
	]);
	submissions = new PluginStorageRepository(
		db,
		"emdash-forms",
		"submissions",
		FORMS_STORAGE_CONFIG.submissions.indexes.map((index) =>
			typeof index === "string" ? index : [...index],
		),
	);
});

afterEach(async () => {
	await db.destroy();
});

type Step = () => Promise<void>;

/**
 * The forms collection, with `meanwhile` run once: right after the first read of the form, or
 * just before the first write if the handler writes without reading it first. This puts another
 * request between a handler's read of the form and its write.
 */
function formsWith(meanwhile: Step): StorageCollection<FormDefinition> {
	let pending: Step | null = meanwhile;
	const runPending = async () => {
		const step = pending;
		pending = null;
		await step?.();
	};
	return {
		...forms,
		get: async (id) => {
			const value = await forms.get(id);
			await runPending();
			return value;
		},
		query: async (options) => {
			const result = await forms.query(options);
			await runPending();
			return result;
		},
		put: async (id, value) => {
			await runPending();
			return forms.put(id, value);
		},
		updateIf: async (id, args) => {
			await runPending();
			return forms.updateIf(id, args);
		},
		delete: (id) => forms.delete(id),
	} as StorageCollection<FormDefinition>;
}

const log = () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() });

function submit(formsCollection = forms) {
	return submitHandler({
		input: submitSchema.parse({
			formId: "apply",
			data: {},
			files: { cv: { filename: "cv.png", contentType: "image/png", bytes: [1, 2, 3] } },
		}),
		storage: { forms: formsCollection, submissions },
		kv: { get: async () => null },
		log: log(),
		media: { upload: async () => ({ mediaId: "m1", storageKey: "k1", url: "/k1" }) },
		requestMeta: { ip: "203.0.113.1", userAgent: "test", referer: null, headers: {} },
	} as never);
}

function deleteSubmission(id: string, formsCollection = forms) {
	return submissionDeleteHandler({
		input: { id },
		storage: { forms: formsCollection, submissions },
	} as never);
}

function cleanup(formsCollection = forms) {
	return handleCleanup({ storage: { forms: formsCollection, submissions }, log: log() } as never);
}

function updateForm(input: unknown, formsCollection = forms) {
	return formsUpdateHandler({
		input: formUpdateSchema.parse(input),
		storage: { forms: formsCollection, submissions },
	} as never);
}

const pauseAndEdit: Step = async () => {
	await updateForm({
		id: "apply",
		status: "paused",
		settings: { notifyEmails: ["new@example.com"] },
	});
};

const deleteForm: Step = async () => {
	await formsDeleteHandler({
		input: formDeleteSchema.parse({ id: "apply" }),
		storage: { forms, submissions },
	} as never);
};

const expired = "2020-01-01T00:00:00.000Z";

const handlers = {
	submit: { seed: async () => {}, run: submit },
	"submissions/delete": {
		seed: async () => {
			await submissions.put("sub-1", submission());
			await submissions.put("sub-2", submission());
		},
		run: (f: StorageCollection<FormDefinition>) => deleteSubmission("sub-1", f),
	},
	cleanup: {
		seed: async () => {
			await submissions.put("old", submission(expired));
			await submissions.put("new", submission());
		},
		run: cleanup,
	},
};

describe.each(Object.entries(handlers))("%s while the form is changed", (_name, handler) => {
	it("keeps the concurrent edit and counts the stored submissions", async () => {
		await forms.put("apply", form());
		await handler.seed();

		await handler.run(formsWith(pauseAndEdit));

		const after = await forms.get("apply");
		expect(after?.status).toBe("paused");
		expect(after?.settings.notifyEmails).toEqual(["new@example.com"]);
		expect(after?.submissionCount).toBe(1);
	});

	it("does not recreate a form deleted in the meantime", async () => {
		await forms.put("apply", form());
		await handler.seed();

		await handler.run(formsWith(deleteForm));

		expect(await forms.get("apply")).toBeNull();
	});
});

describe("saving a form while a submission is recorded", () => {
	it("keeps the submission's counters", async () => {
		await forms.put("apply", form());

		await updateForm(
			{ id: "apply", slug: "apply-now" },
			formsWith(async () => {
				await submit();
			}),
		);

		const after = await forms.get("apply");
		expect(after?.slug).toBe("apply-now");
		expect(after?.submissionCount).toBe(1);
		expect(after?.lastSubmissionAt).toEqual(expect.any(String));
	});

	it("reports a form deleted in the meantime as not found", async () => {
		await forms.put("apply", form());

		await expect(
			updateForm({ id: "apply", slug: "apply-now" }, formsWith(deleteForm)),
		).rejects.toMatchObject({ status: 404 });
		expect(await forms.get("apply")).toBeNull();
	});
});

describe("a stored count that is already wrong", () => {
	it("is corrected by the next submission", async () => {
		await forms.put("apply", form({ submissionCount: 7 }));
		await submissions.put("sub-1", submission());

		await submit();

		expect((await forms.get("apply"))?.submissionCount).toBe(2);
	});

	it("is corrected when a submission is deleted", async () => {
		await forms.put("apply", form({ submissionCount: 1 }));
		await submissions.put("sub-1", submission());
		await submissions.put("sub-2", submission());

		await deleteSubmission("sub-1");

		expect((await forms.get("apply"))?.submissionCount).toBe(1);
	});
});
