/**
 * Tests for the submission → content entry mapping.
 *
 * Covers the behaviors agreed in discussion #1672: no mapping keeps the
 * current behavior, a successful mapping creates a draft and keeps the
 * inbox submission, invalid mappings are rejected on form save, and
 * submit-time create failures never lose the submission.
 */

import type { CollectionInfo, RouteContext } from "emdash";
import { describe, expect, it, vi } from "vitest";

import {
	applyTransform,
	buildContentEntry,
	textToPortableText,
	validateContentMapping,
} from "../src/content-mapping.js";
import {
	formsCreateHandler,
	formsDuplicateHandler,
	formsUpdateHandler,
} from "../src/handlers/forms.js";
import { submitHandler } from "../src/handlers/submit.js";
import type {
	FormCreateInput,
	FormDuplicateInput,
	FormUpdateInput,
	SubmitInput,
} from "../src/schemas.js";
import type { ContentMapping, FormDefinition, FormField, FormPage } from "../src/types.js";

// ─── Fixtures ────────────────────────────────────────────────────

function makeField(overrides: Partial<FormField> & { name: string }): FormField {
	return {
		id: overrides.name,
		type: "text",
		label: overrides.name,
		required: false,
		width: "full",
		...overrides,
	};
}

const formPages: FormPage[] = [
	{
		fields: [
			makeField({ name: "event_title", required: true }),
			makeField({ name: "event_details", type: "textarea" }),
			makeField({ name: "attendee_count", type: "number" }),
			makeField({ name: "event_date", type: "date" }),
		],
	},
];

const eventsCollection: CollectionInfo = {
	slug: "events",
	label: "Events",
	labelSingular: "Event",
	fields: [
		{ slug: "title", label: "Title", type: "text", required: true },
		{ slug: "body", label: "Body", type: "portableText", required: false },
		{ slug: "attendees", label: "Attendees", type: "number", required: false },
		{ slug: "starts_at", label: "Starts at", type: "date", required: false },
		{ slug: "source", label: "Source", type: "text", required: false },
	],
};

const validMapping: ContentMapping = {
	collection: "events",
	fieldMappings: {
		event_title: "title",
		event_details: { field: "body", transform: "portableText" },
		attendee_count: { field: "attendees", transform: "number" },
	},
	slugFrom: "event_title",
	metadata: { source: "form" },
};

function makeForm(overrides: Partial<FormDefinition> = {}): FormDefinition {
	return {
		name: "Event Submission",
		slug: "event-submission",
		pages: formPages,
		settings: {
			confirmationMessage: "Thanks",
			notifyEmails: [],
			digestEnabled: false,
			digestHour: 9,
			retentionDays: 0,
			spamProtection: "none",
			submitLabel: "Submit",
		},
		status: "active",
		submissionCount: 0,
		lastSubmissionAt: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

// ─── Test Context ────────────────────────────────────────────────

interface MemoryCollection {
	items: Map<string, unknown>;
	get(id: string): Promise<unknown>;
	put(id: string, data: unknown): Promise<void>;
	delete(id: string): Promise<boolean>;
	query(options?: {
		where?: Record<string, unknown>;
		limit?: number;
	}): Promise<{ items: Array<{ id: string; data: unknown }>; hasMore: boolean; cursor?: string }>;
	count(where?: Record<string, unknown>): Promise<number>;
}

function createMemoryCollection(): MemoryCollection {
	const items = new Map<string, unknown>();

	async function query(options: { where?: Record<string, unknown>; limit?: number } = {}) {
		const matched = [...items.entries()].filter(([, data]) =>
			Object.entries(options.where ?? {}).every(
				(entry) => (data as Record<string, unknown>)[entry[0]] === entry[1],
			),
		);
		return {
			items: matched.map(([id, data]) => ({ id, data })),
			hasMore: false,
			cursor: undefined,
		};
	}

	return {
		items,
		async get(id: string) {
			return items.get(id) ?? null;
		},
		async put(id: string, data: unknown) {
			items.set(id, data);
		},
		async delete(id: string) {
			return items.delete(id);
		},
		query,
		async count(where: Record<string, unknown> = {}) {
			return (await query({ where })).items.length;
		},
	};
}

interface TestContext<TInput> {
	ctx: RouteContext<TInput>;
	forms: MemoryCollection;
	submissions: MemoryCollection;
	created: Array<{ collection: string; data: Record<string, unknown> }>;
	log: { error: ReturnType<typeof vi.fn> };
}

function createTestContext<TInput>(
	input: TInput,
	options: {
		collections?: Record<string, CollectionInfo>;
		failCreate?: boolean;
	} = {},
): TestContext<TInput> {
	const forms = createMemoryCollection();
	const submissions = createMemoryCollection();
	const created: Array<{ collection: string; data: Record<string, unknown> }> = [];
	const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
	const collections = options.collections ?? { events: eventsCollection };

	const content = {
		async get() {
			return null;
		},
		async list() {
			return { items: [], hasMore: false };
		},
		async getCollection(slug: string) {
			return collections[slug] ?? null;
		},
		async create(collection: string, data: Record<string, unknown>) {
			if (options.failCreate) {
				throw new Error("content create failed");
			}
			created.push({ collection, data });
			return {
				id: "entry-1",
				type: collection,
				slug: null,
				status: "draft",
				locale: "en",
				data,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
				publishedAt: null,
			};
		},
	};

	const ctx = {
		plugin: { id: "emdash-forms", version: "0.0.0" },
		storage: { forms, submissions },
		kv: {
			async get() {
				return null;
			},
			async set() {},
			async delete() {},
			async list() {
				return [];
			},
		},
		content,
		log,
		site: { name: "Test Site", url: "https://example.com", locale: "en" },
		url: (path: string) => `https://example.com${path}`,
		input,
		request: new Request("https://example.com/submit"),
		requestMeta: { ip: null, userAgent: null, referer: null, geo: undefined },
	} as unknown as RouteContext<TInput>;

	return { ctx, forms, submissions, created, log };
}

// ─── Transforms ──────────────────────────────────────────────────

describe("applyTransform", () => {
	it("passes values through without a transform", () => {
		expect(applyTransform("hello")).toBe("hello");
		expect(applyTransform(5)).toBe(5);
	});

	it("stringifies values with the string transform", () => {
		expect(applyTransform(42, "string")).toBe("42");
	});

	it("joins checkbox-group arrays with the string transform", () => {
		expect(applyTransform(["news", "sports"], "string")).toBe("news, sports");
	});

	it("coerces numeric strings with the number transform", () => {
		expect(applyTransform("42", "number")).toBe(42);
	});

	it("skips non-numeric values with the number transform", () => {
		expect(applyTransform("not a number", "number")).toBeUndefined();
	});

	it("converts parseable dates to ISO strings with the date transform", () => {
		expect(applyTransform("2026-08-01", "date")).toBe("2026-08-01T00:00:00.000Z");
	});

	it("skips unparseable values with the date transform", () => {
		expect(applyTransform("not a date", "date")).toBeUndefined();
	});

	it("converts text to Portable Text blocks with the portableText transform", () => {
		const blocks = applyTransform("First paragraph.\n\nSecond paragraph.", "portableText");

		expect(blocks).toMatchObject([
			{
				_type: "block",
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", text: "First paragraph.", marks: [] }],
			},
			{
				_type: "block",
				style: "normal",
				markDefs: [],
				children: [{ _type: "span", text: "Second paragraph.", marks: [] }],
			},
		]);
	});
});

describe("textToPortableText", () => {
	it("returns an empty array for blank text", () => {
		expect(textToPortableText("   \n\n  ")).toEqual([]);
	});

	it("assigns unique keys to blocks and spans", () => {
		const blocks = textToPortableText("One.\n\nTwo.") as Array<{
			_key: string;
			children: Array<{ _key: string }>;
		}>;

		const keys = blocks.flatMap((block) => [block._key, ...block.children.map((c) => c._key)]);
		expect(new Set(keys).size).toBe(keys.length);
	});
});

// ─── Building Entries ────────────────────────────────────────────

describe("buildContentEntry", () => {
	it("maps submitted values onto target fields", () => {
		const entry = buildContentEntry(validMapping, {
			event_title: "Community BBQ",
			attendee_count: 25,
		});

		expect(entry.title).toBe("Community BBQ");
		expect(entry.attendees).toBe(25);
	});

	it("merges metadata constants into the entry", () => {
		const entry = buildContentEntry(validMapping, { event_title: "Community BBQ" });

		expect(entry.source).toBe("form");
	});

	it("sets the reserved slug key from slugFrom", () => {
		const entry = buildContentEntry(validMapping, { event_title: "Community BBQ" });

		expect(entry.slug).toBe("Community BBQ");
	});

	it("skips empty and missing values", () => {
		const entry = buildContentEntry(validMapping, {
			event_title: "Community BBQ",
			event_details: "",
		});

		expect(entry).not.toHaveProperty("body");
		expect(entry).not.toHaveProperty("attendees");
	});
});

// ─── Save-time Validation ────────────────────────────────────────

describe("validateContentMapping", () => {
	it("accepts a valid mapping", async () => {
		const { ctx } = createTestContext(undefined);

		await expect(validateContentMapping(ctx, validMapping, formPages)).resolves.toBeUndefined();
	});

	it("rejects an unknown target collection", async () => {
		const { ctx } = createTestContext(undefined);

		await expect(
			validateContentMapping(ctx, { ...validMapping, collection: "missing" }, formPages),
		).rejects.toThrow(/unknown collection "missing"/);
	});

	it("rejects a mapping from an unknown form field", async () => {
		const { ctx } = createTestContext(undefined);

		await expect(
			validateContentMapping(
				ctx,
				{ ...validMapping, fieldMappings: { ...validMapping.fieldMappings, nope: "title" } },
				formPages,
			),
		).rejects.toThrow(/unknown form field "nope"/);
	});

	it("rejects a mapping onto an unknown collection field", async () => {
		const { ctx } = createTestContext(undefined);

		await expect(
			validateContentMapping(
				ctx,
				{ ...validMapping, fieldMappings: { event_title: "title", event_date: "nope" } },
				formPages,
			),
		).rejects.toThrow(/unknown field "nope"/);
	});

	it("rejects a slugFrom that references an unknown form field", async () => {
		const { ctx } = createTestContext(undefined);

		await expect(
			validateContentMapping(ctx, { ...validMapping, slugFrom: "nope" }, formPages),
		).rejects.toThrow(/slugFrom references unknown form field "nope"/);
	});

	it("rejects metadata that targets an unknown collection field", async () => {
		const { ctx } = createTestContext(undefined);

		await expect(
			validateContentMapping(ctx, { ...validMapping, metadata: { nope: 1 } }, formPages),
		).rejects.toThrow(/metadata targets unknown field "nope"/);
	});

	it("rejects a mapping that leaves a required collection field unmapped", async () => {
		const { ctx } = createTestContext(undefined);

		await expect(
			validateContentMapping(
				ctx,
				{ collection: "events", fieldMappings: { event_details: "body" } },
				formPages,
			),
		).rejects.toThrow(/does not map required field "title"/);
	});

	it("accepts a required collection field covered by metadata", async () => {
		const { ctx } = createTestContext(undefined);

		await expect(
			validateContentMapping(
				ctx,
				{
					collection: "events",
					fieldMappings: { event_details: "body" },
					metadata: { title: "Form submission" },
				},
				formPages,
			),
		).resolves.toBeUndefined();
	});

	it("rejects a nullish metadata constant for a required collection field", async () => {
		const { ctx } = createTestContext(undefined);

		await expect(
			validateContentMapping(
				ctx,
				{
					collection: "events",
					fieldMappings: { event_details: "body" },
					metadata: { title: null },
				},
				formPages,
			),
		).rejects.toThrow(
			/metadata for required field "title" in collection "events" must not be null/,
		);
	});

	it("rejects a required collection field mapped from an optional form field", async () => {
		const { ctx } = createTestContext(undefined);

		// event_details is optional — an empty submission would leave the
		// required "title" field without a value.
		await expect(
			validateContentMapping(
				ctx,
				{ collection: "events", fieldMappings: { event_details: "title" } },
				formPages,
			),
		).rejects.toThrow(/from an optional form field/);
	});
});

// ─── Form Save Handlers ──────────────────────────────────────────

function makeCreateInput(mapping: ContentMapping | undefined): FormCreateInput {
	return {
		name: "Event Submission",
		slug: "event-submission",
		pages: formPages,
		settings: {
			confirmationMessage: "Thanks",
			notifyEmails: [],
			digestEnabled: false,
			digestHour: 9,
			retentionDays: 0,
			spamProtection: "none",
			submitLabel: "Submit",
			contentMapping: mapping,
		},
	};
}

describe("formsCreateHandler with content mapping", () => {
	it("creates a form with a valid mapping", async () => {
		const { ctx, forms } = createTestContext(makeCreateInput(validMapping));

		const result = await formsCreateHandler(ctx);

		expect(result.settings.contentMapping).toEqual(validMapping);
		expect(forms.items.size).toBe(1);
	});

	it("rejects an invalid mapping at save time", async () => {
		const { ctx, forms } = createTestContext(
			makeCreateInput({ ...validMapping, collection: "missing" }),
		);

		await expect(formsCreateHandler(ctx)).rejects.toThrow(/unknown collection "missing"/);
		expect(forms.items.size).toBe(0);
	});
});

describe("formsUpdateHandler with content mapping", () => {
	it("rejects a page edit that breaks an existing mapping", async () => {
		const input: FormUpdateInput = {
			id: "form-1",
			pages: [{ fields: [makeField({ name: "renamed_title", required: true })] }],
		};
		const { ctx, forms } = createTestContext(input);
		await forms.put(
			"form-1",
			makeForm({ settings: { ...makeForm().settings, contentMapping: validMapping } }),
		);

		await expect(formsUpdateHandler(ctx)).rejects.toThrow(/unknown form field "event_title"/);
	});

	it("clears the mapping when contentMapping is null", async () => {
		const input: FormUpdateInput = {
			id: "form-1",
			settings: { contentMapping: null },
		};
		const { ctx, forms } = createTestContext(input);
		await forms.put(
			"form-1",
			makeForm({ settings: { ...makeForm().settings, contentMapping: validMapping } }),
		);

		const result = await formsUpdateHandler(ctx);

		expect(result.settings.contentMapping).toBeUndefined();
	});
});

describe("formsDuplicateHandler with content mapping", () => {
	it("re-validates the mapping when duplicating a form", async () => {
		const input: FormDuplicateInput = { id: "form-1" };
		// The target collection no longer exists, so the stale mapping must
		// be rejected instead of copied into the duplicate.
		const { ctx, forms } = createTestContext(input, { collections: {} });
		await forms.put(
			"form-1",
			makeForm({ settings: { ...makeForm().settings, contentMapping: validMapping } }),
		);

		await expect(formsDuplicateHandler(ctx)).rejects.toThrow(/unknown collection "events"/);
	});
});

// ─── Submit Handler ──────────────────────────────────────────────

function makeSubmitInput(data: Record<string, unknown>): SubmitInput {
	return { formId: "form-1", data };
}

describe("submitHandler with content mapping", () => {
	const submission = {
		event_title: "Community BBQ",
		event_details: "Bring a dish.\n\nAll welcome.",
		attendee_count: "25",
	};

	it("keeps the current behavior when no mapping is configured", async () => {
		const { ctx, forms, submissions, created } = createTestContext(makeSubmitInput(submission));
		await forms.put("form-1", makeForm());

		const result = await submitHandler(ctx);

		expect(result).toMatchObject({ success: true });
		expect(submissions.items.size).toBe(1);
		expect(created).toHaveLength(0);
	});

	it("creates a draft entry and keeps the inbox submission", async () => {
		const { ctx, forms, submissions, created } = createTestContext(makeSubmitInput(submission));
		await forms.put(
			"form-1",
			makeForm({ settings: { ...makeForm().settings, contentMapping: validMapping } }),
		);

		const result = await submitHandler(ctx);

		expect(result).toMatchObject({ success: true });
		// The submission is stored in the inbox regardless of the mapping
		expect(submissions.items.size).toBe(1);

		expect(created).toHaveLength(1);
		expect(created[0]!.collection).toBe("events");
		expect(created[0]!.data).toMatchObject({
			title: "Community BBQ",
			attendees: 25,
			source: "form",
			slug: "Community BBQ",
		});
		expect(created[0]!.data.body).toMatchObject([
			{ _type: "block", children: [{ _type: "span", text: "Bring a dish." }] },
			{ _type: "block", children: [{ _type: "span", text: "All welcome." }] },
		]);
	});

	it("preserves the submission and still succeeds when content creation fails", async () => {
		const { ctx, forms, submissions, created, log } = createTestContext(
			makeSubmitInput(submission),
			{ failCreate: true },
		);
		await forms.put(
			"form-1",
			makeForm({ settings: { ...makeForm().settings, contentMapping: validMapping } }),
		);

		const result = await submitHandler(ctx);

		expect(result).toMatchObject({ success: true });
		expect(submissions.items.size).toBe(1);
		expect(created).toHaveLength(0);
		expect(log.error).toHaveBeenCalledWith(
			"Failed to create content entry from submission",
			expect.objectContaining({ collection: "events" }),
		);
	});
});
