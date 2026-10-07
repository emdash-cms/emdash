import type { CronAccess, PluginContext, RouteContext, StorageCollection } from "emdash";
import { describe, expect, it, vi } from "vitest";

import { validateTaskName } from "../../../core/src/plugins/cron.js";
import { digestTaskName, parseDigestFormId } from "../src/cron-tasks.js";
import {
	formsCreateHandler,
	formsDeleteHandler,
	formsUpdateHandler,
} from "../src/handlers/forms.js";
import { createPlugin } from "../src/index.js";
import { formCreateSchema, formDeleteSchema, formUpdateSchema } from "../src/schemas.js";
import type { FormDefinition, Submission } from "../src/types.js";

function memoryCollection<T>(seed: Record<string, T> = {}) {
	const map = new Map<string, T>(Object.entries(seed));
	return {
		map,
		collection: {
			get: async (id: string) => map.get(id) ?? null,
			put: async (id: string, data: T) => {
				map.set(id, data);
			},
			delete: async (id: string) => map.delete(id),
			exists: async (id: string) => map.has(id),
			getVersioned: async () => null,
			compareAndSet: async () => ({ applied: true, revision: "1" }),
			compareAndDelete: async () => ({ applied: true }),
			getMany: async (ids: string[]) => {
				const result = new Map<string, T>();
				for (const id of ids) {
					const value = map.get(id);
					if (value !== undefined) result.set(id, value);
				}
				return result;
			},
			putMany: async (items: Array<{ id: string; data: T }>) => {
				for (const { id, data } of items) map.set(id, data);
			},
			deleteMany: async (ids: string[]) => {
				let count = 0;
				for (const id of ids) {
					if (map.delete(id)) count++;
				}
				return count;
			},
			query: async () => ({
				items: Array.from(map.entries(), ([id, data]) => ({ id, data })),
				hasMore: false,
			}),
			count: async () => map.size,
			updateIf: async () => ({ applied: false }),
		} as StorageCollection<T>,
	};
}

function buildContext<T>(input: T) {
	const forms = memoryCollection<FormDefinition>();
	const submissions = memoryCollection<Submission>();
	const scheduled = new Map<string, { schedule: string }>();
	const cancelled: string[] = [];
	const emails: Array<{ to: string; subject: string; text: string }> = [];

	const cron: CronAccess = {
		schedule: vi.fn(async (name: string, opts: { schedule: string }) => {
			// Replicate the core validation this plugin depends on so a regression
			// in task-name format fails this test the same way it fails in production.
			validateTaskName(name);
			scheduled.set(name, opts);
		}),
		cancel: vi.fn(async (name: string) => {
			cancelled.push(name);
			scheduled.delete(name);
		}),
		list: vi.fn(async () => []),
	};

	const ctx = {
		plugin: { id: "emdash-forms", version: "test" },
		storage: {
			forms: forms.collection,
			submissions: submissions.collection,
		},
		kv: {
			get: vi.fn(async () => null),
			set: vi.fn(async () => {}),
			delete: vi.fn(async () => true),
			list: vi.fn(async () => []),
			getVersioned: vi.fn(async () => null),
			compareAndSet: vi.fn(async () => ({ applied: false })),
			compareAndDelete: vi.fn(async () => ({ applied: false })),
		},
		settings: {
			get: vi.fn(async () => null),
			set: vi.fn(async () => {}),
			delete: vi.fn(async () => true),
			list: vi.fn(async () => []),
			getVersioned: vi.fn(async () => null),
			compareAndSet: vi.fn(async () => ({ applied: false })),
			compareAndDelete: vi.fn(async () => ({ applied: false })),
		},
		log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
		site: {
			name: "Test Site",
			url: "https://example.com",
			locale: "en",
			trailingSlash: "ignore",
		},
		url: (path: string) => `https://example.com${path}`,
		cron,
		email: {
			send: vi.fn(async (message: { to: string; subject: string; text: string }) => {
				emails.push(message);
			}),
		},
		request: new Request("https://example.com/_emdash/api/plugins/emdash-forms/forms/create"),
		requestMeta: {
			ip: "203.0.113.1",
			userAgent: "test",
			referer: null,
			geo: null,
			headers: {},
		},
		user: {
			id: "u1",
			email: "admin@example.com",
			name: "Admin",
			role: 3,
			createdAt: "2026-01-01T00:00:00.000Z",
		},
		input,
	} as unknown as RouteContext;

	return {
		ctx,
		forms: forms.collection,
		formsMap: forms.map,
		submissions: submissions.collection,
		submissionsMap: submissions.map,
		cron,
		scheduled,
		cancelled,
		emails,
	};
}

const baseFormInput = {
	name: "Contact",
	slug: "contact",
	pages: [
		{
			fields: [
				{
					id: "f1",
					type: "text" as const,
					label: "Email",
					name: "email",
					required: false,
					width: "full" as const,
				},
			],
		},
	],
	settings: {
		notifyEmails: ["editor@example.com"],
		digestEnabled: true,
		digestHour: 9,
	},
};

describe("daily digest task scheduling", () => {
	it("creates a form with digest enabled without throwing and schedules a valid task name", async () => {
		const input = formCreateSchema.parse(baseFormInput);
		const { ctx, scheduled, cron } = buildContext(input);

		const result = await formsCreateHandler(ctx);

		expect(result.settings.digestEnabled).toBe(true);
		expect(cron.schedule).toHaveBeenCalledOnce();

		const taskName = cron.schedule.mock.calls[0]![0];
		const opts = cron.schedule.mock.calls[0]![1];

		// Must pass core's task-name validation (colons fail here).
		expect(() => validateTaskName(taskName)).not.toThrow();
		expect(taskName).toBe(digestTaskName(result.id));
		expect(parseDigestFormId(taskName)).toBe(result.id);
		expect(opts).toEqual({ schedule: "0 9 * * *" });
		expect(scheduled.get(taskName)).toEqual({ schedule: "0 9 * * *" });
	});

	it("re-schedules the digest task when the hour changes", async () => {
		const createInput = formCreateSchema.parse(baseFormInput);
		const createCtx = buildContext(createInput);
		const created = await formsCreateHandler(createCtx.ctx);

		const updateInput = formUpdateSchema.parse({
			id: created.id,
			settings: { digestHour: 14 },
		});
		const updateCtx = buildContext(updateInput);
		// Seed storage with the existing form so the update finds it.
		await updateCtx.forms.put(created.id, created as FormDefinition);

		await formsUpdateHandler(updateCtx.ctx);

		expect(updateCtx.cron.schedule).toHaveBeenCalledOnce();
		const taskName = digestTaskName(created.id);
		expect(updateCtx.cron.schedule.mock.calls[0]![0]).toBe(taskName);
		expect(updateCtx.cron.schedule.mock.calls[0]![1]).toEqual({ schedule: "0 14 * * *" });
		expect(updateCtx.scheduled.get(taskName)).toEqual({ schedule: "0 14 * * *" });
	});

	it("cancels the digest task when digest is disabled", async () => {
		const createInput = formCreateSchema.parse(baseFormInput);
		const createCtx = buildContext(createInput);
		const created = await formsCreateHandler(createCtx.ctx);

		const updateInput = formUpdateSchema.parse({
			id: created.id,
			settings: { digestEnabled: false },
		});
		const updateCtx = buildContext(updateInput);
		await updateCtx.forms.put(created.id, created as FormDefinition);

		await formsUpdateHandler(updateCtx.ctx);

		expect(updateCtx.cron.cancel).toHaveBeenCalledOnce();
		expect(updateCtx.cron.cancel.mock.calls[0]![0]).toBe(digestTaskName(created.id));
	});

	it("cancels the digest task when the form is deleted", async () => {
		const createInput = formCreateSchema.parse(baseFormInput);
		const createCtx = buildContext(createInput);
		const created = await formsCreateHandler(createCtx.ctx);

		const deleteInput = formDeleteSchema.parse({ id: created.id });
		const deleteCtx = buildContext(deleteInput);
		await deleteCtx.forms.put(created.id, created as FormDefinition);

		await formsDeleteHandler(deleteCtx.ctx);

		expect(deleteCtx.cron.cancel).toHaveBeenCalledOnce();
		expect(deleteCtx.cron.cancel.mock.calls[0]![0]).toBe(digestTaskName(created.id));
	});

	it("routes digest tasks through the plugin cron hook and sends a digest email", async () => {
		const input = formCreateSchema.parse(baseFormInput);
		const { ctx, submissions, emails } = buildContext(input);

		const created = await formsCreateHandler(ctx);
		const formId = created.id;

		await submissions.put("s1", {
			formId,
			data: { email: "visitor@example.com" },
			status: "new",
			starred: false,
			createdAt: new Date().toISOString(),
			meta: { ip: null, userAgent: null, referer: null, country: null },
		});

		const plugin = createPlugin();
		const handler = plugin.hooks?.cron?.handler;
		expect(handler).toBeDefined();

		await handler!(
			{ name: digestTaskName(formId), scheduledAt: new Date().toISOString() },
			ctx as unknown as PluginContext,
		);

		expect(emails).toHaveLength(1);
		expect(emails[0]?.to).toBe("editor@example.com");
		expect(emails[0]?.subject).toContain("Daily digest");
		expect(emails[0]?.text).toContain("visitor@example.com");
	});
});
