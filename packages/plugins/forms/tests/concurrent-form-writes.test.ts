import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleCleanup } from "../src/handlers/cron.js";
import { formsCreateHandler, formsUpdateHandler } from "../src/handlers/forms.js";
import { submissionDeleteHandler } from "../src/handlers/submissions.js";
import { submitHandler } from "../src/handlers/submit.js";
import { formCreateSchema, formUpdateSchema, submitSchema } from "../src/schemas.js";
import type { FormDefinition, Submission } from "../src/types.js";
import { createFormsStorage, holdFirstCall, type FormsStorage } from "./real-storage.js";

type Storage = FormsStorage["storage"];

const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const requestMeta = { ip: "203.0.113.1", userAgent: "test", referer: null, headers: {} };

let harness: FormsStorage;

beforeEach(async () => {
	harness = await createFormsStorage();
});

afterEach(async () => {
	await harness.db.destroy();
});

async function createForm(
	storage: Storage,
	settings: Record<string, unknown> = {},
): Promise<string> {
	const created = await formsCreateHandler({
		input: formCreateSchema.parse({
			name: "Contact",
			slug: "contact",
			pages: [
				{
					fields: [
						{ id: "f1", type: "text", label: "Name", name: "name", required: true, width: "full" },
					],
				},
			],
			settings: { spamProtection: "none", ...settings },
		}),
		storage,
	} as never);
	return created.id;
}

function submit(storage: Storage, formId: string, extra: Record<string, unknown> = {}) {
	return submitHandler({
		input: submitSchema.parse({ formId, data: { name: "Jane" } }),
		storage,
		kv: { get: async () => null },
		log,
		requestMeta,
		...extra,
	} as never);
}

function update(storage: Storage, input: Record<string, unknown>) {
	return formsUpdateHandler({ input: formUpdateSchema.parse(input), storage, log } as never);
}

async function storedForm(formId: string): Promise<FormDefinition> {
	const form = await harness.storage.forms.get(formId);
	if (!form) throw new Error("form missing");
	return form as FormDefinition;
}

async function submissionIds(formId: string): Promise<string[]> {
	const result = await harness.storage.submissions.query({ where: { formId }, limit: 100 });
	return result.items.map((item) => item.id);
}

describe("a form edit made while a submission is being saved", () => {
	it("survives the submission", async () => {
		const { storage } = harness;
		const formId = await createForm(storage, { spamProtection: "turnstile" });

		let verify!: () => void;
		const verified = new Promise<void>((resolve) => (verify = resolve));
		let markVerifying!: () => void;
		const verifying = new Promise<void>((resolve) => (markVerifying = resolve));
		const fetch = vi.fn(async () => {
			markVerifying();
			await verified;
			return Response.json({ success: true });
		});

		const pending = submitHandler({
			input: submitSchema.parse({
				formId,
				data: { name: "Jane", "cf-turnstile-response": "token" },
			}),
			storage,
			kv: { get: async (key: string) => (key === "settings:turnstileSecretKey" ? "secret" : null) },
			http: { fetch },
			log,
			requestMeta,
		} as never);

		await verifying;
		await update(storage, { id: formId, name: "Support", status: "paused" });
		verify();
		await expect(pending).resolves.toMatchObject({ success: true });

		const form = await storedForm(formId);
		expect(form.name).toBe("Support");
		expect(form.status).toBe("paused");
		expect(form.submissionCount).toBe(1);
		expect(form.lastSubmissionAt).not.toBeNull();
	});
});

describe("the submission count", () => {
	it("counts both of two overlapping submissions", async () => {
		const { storage } = harness;
		const formId = await createForm(storage);

		const held = holdFirstCall(storage.forms, ["put", "updateIf"]);
		const first = submit({ ...storage, forms: held.proxy }, formId);
		await held.reached;
		await submit(storage, formId);
		held.release();
		await first;

		expect((await storedForm(formId)).submissionCount).toBe(2);
		expect(await submissionIds(formId)).toHaveLength(2);
	});

	it("is not reverted by a form edit that overlaps a submission", async () => {
		const { storage } = harness;
		const formId = await createForm(storage);

		const held = holdFirstCall(storage.forms, ["put", "updateIf"]);
		const editing = update({ ...storage, forms: held.proxy }, { id: formId, name: "Support" });
		await held.reached;
		await submit(storage, formId);
		held.release();
		const updated = await editing;

		const form = await storedForm(formId);
		expect(form.name).toBe("Support");
		expect(form.submissionCount).toBe(1);
		expect(updated).toMatchObject({ id: formId, name: "Support", submissionCount: 1 });
	});
});

describe("deleting a submission", () => {
	it("lowers the count without undoing an overlapping form edit", async () => {
		const { storage } = harness;
		const formId = await createForm(storage);
		await submit(storage, formId);
		await submit(storage, formId);
		const [target] = await submissionIds(formId);

		const held = holdFirstCall(storage.forms, ["put", "updateIf"]);
		const deleting = submissionDeleteHandler({
			input: { id: target },
			storage: { ...storage, forms: held.proxy },
		} as never);
		await held.reached;
		await update(storage, { id: formId, name: "Support", status: "paused" });
		held.release();
		await deleting;

		const form = await storedForm(formId);
		expect(form.name).toBe("Support");
		expect(form.status).toBe("paused");
		expect(form.submissionCount).toBe(1);
	});

	it("lowers the count once when the same submission is deleted twice at once", async () => {
		const { storage } = harness;
		const formId = await createForm(storage);
		await submit(storage, formId);
		await submit(storage, formId);
		const [target] = await submissionIds(formId);

		const held = holdFirstCall(storage.submissions, ["delete"]);
		const first = submissionDeleteHandler({
			input: { id: target },
			storage: { ...storage, submissions: held.proxy },
		} as never);
		await held.reached;
		await submissionDeleteHandler({ input: { id: target }, storage } as never);
		held.release();
		await first;

		expect((await storedForm(formId)).submissionCount).toBe(1);
	});

	it("does not take the count below zero", async () => {
		const { storage } = harness;
		const formId = await createForm(storage);
		await submit(storage, formId);
		const [target] = await submissionIds(formId);
		await storage.forms.updateIf(formId, { where: {}, set: { submissionCount: 0 } });

		await submissionDeleteHandler({ input: { id: target }, storage } as never);

		expect((await storedForm(formId)).submissionCount).toBe(0);
	});
});

describe("the retention cleanup", () => {
	async function ageSubmissions(ids: string[]) {
		const old = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString();
		for (const id of ids) {
			const sub = (await harness.storage.submissions.get(id)) as Submission;
			await harness.storage.submissions.put(id, { ...sub, createdAt: old });
		}
	}

	it("lowers the count by the expired submissions without undoing an overlapping edit", async () => {
		const { storage } = harness;
		const formId = await createForm(storage, { retentionDays: 30 });
		await submit(storage, formId);
		await submit(storage, formId);
		await submit(storage, formId);
		await ageSubmissions((await submissionIds(formId)).slice(0, 2));

		const held = holdFirstCall(storage.forms, ["put", "updateIf"]);
		const cleaning = handleCleanup({ storage: { ...storage, forms: held.proxy }, log } as never);
		await held.reached;
		await update(storage, { id: formId, name: "Support", status: "paused" });
		held.release();
		await cleaning;

		const form = await storedForm(formId);
		expect(await submissionIds(formId)).toHaveLength(1);
		expect(form.submissionCount).toBe(1);
		expect(form.name).toBe("Support");
		expect(form.status).toBe("paused");
	});

	it("stops the count at zero when it was already lower than the expired submissions", async () => {
		const { storage } = harness;
		const formId = await createForm(storage, { retentionDays: 30 });
		await submit(storage, formId);
		await submit(storage, formId);
		await ageSubmissions(await submissionIds(formId));
		await storage.forms.updateIf(formId, { where: {}, set: { submissionCount: 1 } });

		await handleCleanup({ storage, log } as never);

		expect(await submissionIds(formId)).toHaveLength(0);
		expect((await storedForm(formId)).submissionCount).toBe(0);
	});
});

describe("updating a form", () => {
	it("still refuses a slug another form uses", async () => {
		const { storage } = harness;
		const formId = await createForm(storage);
		await formsCreateHandler({
			input: formCreateSchema.parse({
				name: "Other",
				slug: "other",
				pages: [
					{
						fields: [
							{ id: "f1", type: "text", label: "A", name: "a", required: false, width: "full" },
						],
					},
				],
				settings: {},
			}),
			storage,
		} as never);

		await expect(update(storage, { id: formId, slug: "other" })).rejects.toMatchObject({
			code: "CONFLICT",
		});
		expect((await storedForm(formId)).slug).toBe("contact");
	});

	it("reports a form deleted before the edit is saved as not found, and does not recreate it", async () => {
		const { storage } = harness;
		const formId = await createForm(storage);

		const held = holdFirstCall(storage.forms, ["put", "updateIf"]);
		const editing = update({ ...storage, forms: held.proxy }, { id: formId, name: "Support" });
		await held.reached;
		await storage.forms.delete(formId);
		held.release();

		await expect(editing).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(await storage.forms.get(formId)).toBeNull();
	});
});
