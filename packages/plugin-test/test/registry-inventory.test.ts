import type { Block, Element, LinkElement } from "@emdash-cms/blocks/server";
import {
	CURRENT_PLUGIN_CAPABILITIES,
	DEPRECATED_PLUGIN_CAPABILITIES,
	HOOK_NAMES,
	PLUGIN_ROUTE_BODY_MODES,
	PLUGIN_ROUTE_METHODS,
} from "@emdash-cms/plugin-types";
import type { PluginContext } from "emdash/plugin";
import { afterEach, describe, expect, it } from "vitest";

import {
	createPluginRuntimeTestHost,
	createPluginTestHost,
	type PluginRuntimeTestHost,
	type PluginTestHost,
} from "../src/index.js";

type MethodKeys<T> = {
	[K in keyof T]-?: NonNullable<T[K]> extends (...args: never[]) => unknown ? K : never;
}[keyof T] &
	string;

type ContextApiRoutes = {
	content: Record<MethodKeys<NonNullable<PluginContext["content"]>>, string | null>;
	schema: Record<MethodKeys<NonNullable<PluginContext["schema"]>>, string | null>;
	taxonomies: Record<MethodKeys<NonNullable<PluginContext["taxonomies"]>>, string | null>;
	redirects: Record<MethodKeys<NonNullable<PluginContext["redirects"]>>, string | null>;
	media: Record<MethodKeys<NonNullable<PluginContext["media"]>>, string | null>;
	http: Record<MethodKeys<NonNullable<PluginContext["http"]>>, string | null>;
	users: Record<MethodKeys<NonNullable<PluginContext["users"]>>, string | null>;
	comments: Record<MethodKeys<NonNullable<PluginContext["comments"]>>, string | null>;
	cron: Record<MethodKeys<NonNullable<PluginContext["cron"]>>, string | null>;
	email: Record<MethodKeys<NonNullable<PluginContext["email"]>>, string | null>;
	kv: Record<MethodKeys<PluginContext["kv"]>, string | null>;
	settings: Record<MethodKeys<PluginContext["settings"]>, string | null>;
	storage: Record<MethodKeys<PluginContext["storage"][string]>, string | null>;
	log: Record<MethodKeys<PluginContext["log"]>, string | null>;
};

const CONTEXT_API_ROUTES = {
	content: {
		get: "content-crud",
		list: "content-crud",
		getTranslations: "content-discovery",
		getPublicUrl: "content-discovery",
		listRevisions: "content-discovery",
		getRevision: "revision-discovery",
		create: "content-crud",
		update: "content-crud",
		delete: "content-crud",
		getVersioned: "content-action",
		publish: "content-action",
		unpublish: "content-action",
		schedule: "content-action",
		unschedule: "content-action",
		getTrashedVersioned: "content-action",
		restore: "content-action",
	},
	schema: { listCollections: "schema-exercise", getCollection: "schema-exercise" },
	taxonomies: {
		getAll: "taxonomy-read",
		getTerms: "taxonomy-read",
		getEntryTerms: "taxonomy-read",
		createTerm: "taxonomy-create",
		addEntryTerms: "taxonomy-add",
		removeEntryTerms: "taxonomy-remove",
	},
	redirects: {
		list: "redirects",
		get: "redirects",
		create: "redirects",
		update: "redirects",
		delete: "redirects",
	},
	media: {
		get: "media-get",
		list: "media-exercise",
		readBytes: "media-read-bytes",
		updateMetadata: "media-exercise",
		getUploadUrl: null,
		upload: "media-exercise",
		delete: "media-exercise",
	},
	http: { fetch: "http-roundtrip" },
	users: { get: "users-exercise", getByEmail: "users-exercise", list: "users-exercise" },
	comments: {
		get: "comments-read",
		list: "comments-read",
		count: "comments-read",
		setStatus: "comments-moderate",
	},
	cron: { schedule: "cron-exercise", cancel: "cron-exercise", list: "cron-exercise" },
	email: { send: "send-email" },
	kv: {
		get: "kv-exercise",
		getVersioned: "kv-exercise",
		compareAndSet: "kv-exercise",
		compareAndDelete: "kv-exercise",
		set: "kv-exercise",
		delete: "kv-exercise",
		list: "kv-exercise",
	},
	settings: {
		get: "settings-exercise",
		getVersioned: "settings-exercise",
		compareAndSet: "settings-exercise",
		compareAndDelete: "settings-exercise",
		set: "settings-exercise",
		delete: "settings-exercise",
		list: "settings-exercise",
	},
	storage: {
		get: "storage-exercise",
		put: "storage-exercise",
		delete: "storage-exercise",
		exists: "storage-exercise",
		getVersioned: "storage-exercise",
		compareAndSet: "storage-exercise",
		compareAndDelete: "storage-exercise",
		getMany: "storage-exercise",
		putMany: "storage-exercise",
		deleteMany: "storage-exercise",
		query: "storage-exercise",
		count: "storage-exercise",
		updateIf: "storage-exercise",
	},
	log: {
		debug: "logging-exercise",
		info: "logging-exercise",
		warn: "logging-exercise",
		error: "logging-exercise",
	},
} as const satisfies ContextApiRoutes;

const BLOCK_DECISIONS = {
	header: "components",
	section: "components",
	divider: "components",
	fields: "components",
	table: "components",
	actions: "components",
	stats: "components",
	form: "components",
	image: "components",
	context: "components",
	columns: "components",
	chart: "components",
	code: "components",
	meter: "components",
	banner: "components",
	empty: "components",
	accordion: "components",
	tab: "components",
} as const satisfies Record<Block["type"], "components">;

const ELEMENT_DECISIONS = {
	button: "components",
	link: "components",
	text_input: "components",
	number_input: "components",
	select: "components",
	toggle: "components",
	secret_input: "components",
	checkbox: "components",
	radio: "components",
	date_input: "components",
	combobox: "components",
	repeater: "authoring-only",
	media_picker: "field-widget",
} as const satisfies Record<
	Element["type"] | LinkElement["type"],
	"components" | "authoring-only" | "field-widget"
>;

let host: PluginTestHost | undefined;
let runtimeHost: PluginRuntimeTestHost | undefined;

afterEach(async () => {
	await host?.dispose();
	await runtimeHost?.dispose();
	host = undefined;
	runtimeHost = undefined;
});

function routeNames(testHost: PluginTestHost): Set<string> {
	return new Set(
		testHost.manifest.routes.map((route) => (typeof route === "string" ? route : route.name)),
	);
}

describe("registry fixture capability inventory", () => {
	it("covers every canonical capability and hook without authoring legacy aliases", async () => {
		host = await createPluginTestHost();
		expect(new Set(host.manifest.capabilities)).toEqual(new Set(CURRENT_PLUGIN_CAPABILITIES));
		expect(
			host.manifest.capabilities.filter((capability) =>
				DEPRECATED_PLUGIN_CAPABILITIES.includes(
					capability as (typeof DEPRECATED_PLUGIN_CAPABILITIES)[number],
				),
			),
		).toEqual([]);
		const hooks = host.manifest.hooks.map((hook) => (typeof hook === "string" ? hook : hook.name));
		expect(new Set(hooks)).toEqual(new Set(HOOK_NAMES));
		expect(host.manifest.mcp?.tools).toEqual([
			expect.objectContaining({ name: "runDiagnostics", destructive: false }),
			expect.objectContaining({ name: "deleteRecord", destructive: true }),
		]);
	});

	it("maps every PluginContext method to a declared deterministic route", async () => {
		host = await createPluginTestHost();
		const declared = routeNames(host);
		const mapped = Object.values(CONTEXT_API_ROUTES)
			.flatMap((group) => Object.values(group))
			.filter((route): route is NonNullable<typeof route> => route !== null);
		for (const route of mapped) expect(declared).toContain(route);
		expect(CONTEXT_API_ROUTES.media.getUploadUrl).toBeNull();
	});

	it("round-trips every request body mode, HTTP method, raw response, and public cache policy", async () => {
		host = await createPluginTestHost();
		const entries = host.manifest.routes.map((route) =>
			typeof route === "string" ? { name: route } : route,
		);
		const modes = new Set(entries.flatMap((route) => (route.request ? [route.request.body] : [])));
		for (const mode of PLUGIN_ROUTE_BODY_MODES) expect(modes).toContain(mode);
		const methods = new Set(entries.flatMap((route) => route.methods ?? []));
		for (const method of PLUGIN_ROUTE_METHODS) expect(methods).toContain(method);
		expect(entries).toContainEqual(expect.objectContaining({ response: "raw", public: true }));
		expect(entries).toContainEqual(
			expect.objectContaining({ public: true, cacheControl: "public, max-age=60" }),
		);
	});

	it("renders every supported Block Kit block and admin form element in Arabic RTL", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		const response = await runtimeHost.admin.loadPage("/components", { locale: "ar" });
		const blockTypes = new Set(response.blocks.map((block) => block.type));
		for (const type of Object.keys(BLOCK_DECISIONS)) {
			expect(blockTypes).toContain(type);
		}
		const form = response.blocks.find((block) => block.type === "form");
		if (!form || form.type !== "form") throw new Error("Component form was not rendered");
		expect(new Set(form.fields.map((field) => field.type))).toEqual(
			new Set(
				Object.entries(ELEMENT_DECISIONS)
					.filter(
						([type, decision]) => decision === "components" && type !== "button" && type !== "link",
					)
					.map(([type]) => type),
			),
		);
		const fields = response.blocks.find((block) => block.type === "fields");
		if (!fields || fields.type !== "fields") throw new Error("Context fields were not rendered");
		expect(fields.fields).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ label: "Locale", value: "ar" }),
				expect.objectContaining({ label: "Direction", value: "rtl" }),
			]),
		);
	});

	it("keeps diagnostics links valid without a configured site URL and returns a success toast", async () => {
		runtimeHost = await createPluginRuntimeTestHost({ site: { url: "" } });
		const page = await runtimeHost.admin.loadPage("/overview", { locale: "ar" });
		const actions = page.blocks.find((block) => block.type === "actions");
		if (!actions || actions.type !== "actions")
			throw new Error("Diagnostics actions were not rendered");
		expect(actions.elements).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ type: "button", action_id: "run-diagnostics" }),
				expect.objectContaining({
					type: "link",
					target: { kind: "external", url: "https://docs.example.test/plugin" },
				}),
			]),
		);
		await expect(
			runtimeHost.admin.act("/overview", "run-diagnostics", { locale: "ar" }),
		).resolves.toMatchObject({
			toast: { type: "success", message: "Diagnostics passed" },
		});
	});

	it("round-trips every declared admin extension and settings field type", async () => {
		host = await createPluginTestHost();
		expect(host.manifest.admin.pages).toHaveLength(2);
		expect(host.manifest.admin.widgets).toHaveLength(2);
		expect(host.manifest.admin.editorPanels).toHaveLength(1);
		expect(host.manifest.admin.editorActions).toHaveLength(2);
		expect(host.manifest.admin.fieldWidgets?.[0]?.elements?.map((element) => element.type)).toEqual(
			["text_input", "number_input", "toggle", "select", "media_picker"],
		);
		expect(
			new Set(Object.values(host.manifest.admin.settingsSchema ?? {}).map((field) => field.type)),
		).toEqual(new Set(["string", "number", "boolean", "select", "secret", "url", "email"]));
	});

	it("executes comment, email, page metadata, and trusted-only fragment handlers in the isolate", async () => {
		host = await createPluginTestHost();
		const commentEvent = {
			comment: {
				collection: "posts",
				contentId: "post-1",
				parentId: null,
				authorName: "Reader",
				authorEmail: "reader@example.test",
				authorUserId: null,
				body: "Hello",
				ipHash: "hash",
				userAgent: "test",
			},
			metadata: {},
		};
		await expect(host.invokeHook("comment:beforeCreate", commentEvent)).resolves.toMatchObject({
			metadata: { registryTest: true },
		});
		await expect(
			host.invokeHook("comment:moderate", {
				...commentEvent,
				collectionSettings: {
					commentsEnabled: true,
					commentsModeration: "all",
					commentsClosedAfterDays: 0,
					commentsAutoApproveUsers: false,
				},
				priorApprovedCount: 0,
			}),
		).resolves.toEqual({ status: "pending", reason: "Registry fixture moderation" });
		const message = { to: "reader@example.test", subject: "Fixture", text: "Body" };
		await expect(
			host.invokeHook("email:beforeSend", { message, source: "marketplace-test" }),
		).resolves.toEqual(message);
		await expect(
			host.invokeHook("email:deliver", { message, source: "marketplace-test" }),
		).resolves.toBeUndefined();
		await expect(
			host.invokeHook("email:afterSend", { message, source: "marketplace-test" }),
		).resolves.toBeUndefined();
		const page = {
			url: "https://plugin.test/article",
			path: "/article",
			locale: "en",
			kind: "custom",
			pageType: "page",
			title: "Article",
			description: null,
			canonical: null,
			image: null,
		};
		await expect(host.invokeHook("page:metadata", { page })).resolves.toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "meta", name: "emdash-plugin" }),
				expect.objectContaining({ kind: "jsonld", id: "marketplace-test" }),
			]),
		);
		await expect(host.invokeHook("page:fragments", { page })).resolves.toEqual([
			expect.objectContaining({ kind: "html", placement: "body:end" }),
		]);
	});

	it("executes storage, KV, settings, schema, users, media, cron, and diagnostics through the runtime", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		await runtimeHost.fixtures.collection({
			slug: "posts",
			label: "Posts",
			fields: [{ slug: "title", label: "Title", type: "string" }],
		});
		await runtimeHost.fixtures.taxonomyDefinition({
			name: "category",
			label: "Categories",
			collections: ["posts"],
		});
		const admin = await runtimeHost.fixtures.user({
			email: "maximal-fixture@example.test",
			name: "Maximal Fixture",
			role: "admin",
		});
		const invoke = async (name: string, body: unknown = {}) => {
			const response = await runtimeHost!.actions.routes.request(name, {
				user: admin,
				headers: { "X-EmDash-Request": "1" },
				body,
			});
			expect(response.status).toBe(200);
			const payload = (await response.json()) as { data: unknown };
			return payload.data;
		};

		await expect(invoke("storage-exercise")).resolves.toMatchObject({
			exists: true,
			count: 3,
			staleApplied: false,
			removed: true,
			deletedMany: 2,
		});
		await expect(invoke("kv-exercise")).resolves.toMatchObject({
			plain: { ok: true },
			staleApplied: false,
			removed: true,
		});
		await expect(invoke("settings-exercise")).resolves.toMatchObject({
			current: { value: "second" },
			staleApplied: false,
			removed: true,
		});
		await expect(invoke("schema-exercise")).resolves.toMatchObject({
			posts: { slug: "posts" },
		});
		await expect(
			invoke("users-exercise", { id: admin.id, email: admin.email }),
		).resolves.toMatchObject({
			byId: { id: admin.id },
			byEmail: { id: admin.id },
		});
		const createdContent = (await invoke("content-crud", {
			operation: "create",
			data: { title: "Mapped API" },
		})) as { id: string };
		await expect(
			invoke("content-crud", { operation: "get", id: createdContent.id }),
		).resolves.toMatchObject({ id: createdContent.id, data: { title: "Mapped API [sandbox]" } });
		await expect(invoke("content-crud", { operation: "list" })).resolves.toMatchObject({
			items: [expect.objectContaining({ id: createdContent.id })],
		});
		await expect(
			invoke("content-crud", {
				operation: "update",
				id: createdContent.id,
				data: { title: "Updated API" },
			}),
		).resolves.toMatchObject({ id: createdContent.id, data: { title: "Updated API" } });
		const createdTerm = (await invoke("taxonomy-create", {
			taxonomy: "category",
			label: "Fixture",
		})) as { id: string };
		await expect(
			invoke("taxonomy-add", { entryId: createdContent.id, termIds: [createdTerm.id] }),
		).resolves.toEqual([expect.objectContaining({ id: createdTerm.id })]);
		await expect(invoke("taxonomy-read", { entryId: createdContent.id })).resolves.toMatchObject({
			definitions: expect.arrayContaining([expect.objectContaining({ name: "category" })]),
			terms: expect.arrayContaining([expect.objectContaining({ id: createdTerm.id })]),
			assigned: expect.arrayContaining([expect.objectContaining({ id: createdTerm.id })]),
		});
		await expect(
			invoke("taxonomy-remove", { entryId: createdContent.id, termIds: [createdTerm.id] }),
		).resolves.toEqual([]);
		const upload = (await invoke("media-exercise", { operation: "upload" })) as {
			mediaId: string;
		};
		expect(upload.mediaId).toEqual(expect.any(String));
		await expect(invoke("media-exercise", { operation: "list" })).resolves.toMatchObject({
			items: [expect.objectContaining({ id: upload.mediaId, filename: "fixture.pdf" })],
		});
		await expect(
			invoke("media-exercise", { operation: "metadata", id: upload.mediaId }),
		).resolves.toMatchObject({
			id: upload.mediaId,
			alt: "Fixture alt",
			caption: "Fixture caption",
			focalX: 0.25,
			focalY: 0.75,
		});
		await expect(invoke("media-get", { id: upload.mediaId })).resolves.toMatchObject({
			id: upload.mediaId,
			alt: "Fixture alt",
		});
		await expect(
			invoke("media-exercise", { operation: "delete", id: upload.mediaId }),
		).resolves.toEqual({ deleted: true });
		await expect(invoke("logging-exercise")).resolves.toEqual({ logged: true });
		await runtimeHost.fixtures.plugin.storage("records", "mcp-delete", {
			externalId: "mcp-delete",
			status: "pending",
			score: 1,
		});
		await expect(invoke("records/delete", { id: "mcp-delete" })).resolves.toEqual({
			deleted: true,
		});
		await expect(runtimeHost.inspect.storage.get("records", "mcp-delete")).resolves.toBeNull();
		const deleteWithGet = await runtimeHost.actions.routes.request("records/delete", {
			method: "GET",
			user: admin,
			headers: { "X-EmDash-Request": "1" },
		});
		expect(deleteWithGet.status).toBe(405);
		expect(deleteWithGet.headers.get("allow")).toBe("POST");
		await expect(invoke("cron-exercise")).resolves.toMatchObject({
			scheduled: [expect.objectContaining({ name: "diagnostic" })],
			remaining: [],
		});
		await expect(invoke("diagnostics")).resolves.toMatchObject({
			plugin: { id: "marketplace-test" },
			authority: {
				content: true,
				schema: true,
				taxonomies: true,
				redirects: true,
				media: true,
				http: true,
				users: true,
				comments: true,
				email: true,
			},
		});
		await expect(
			invoke("content-crud", { operation: "delete", id: createdContent.id }),
		).resolves.toEqual({ deleted: true });
	});

	it("enforces declared parsers, byte preservation, raw output, and method Allow behavior", async () => {
		runtimeHost = await createPluginRuntimeTestHost();
		const request = (
			name: string,
			init: Parameters<PluginRuntimeTestHost["actions"]["routes"]["request"]>[1],
		) => runtimeHost!.actions.routes.request(name, init);

		const json = await request("body-json", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			rawBody: JSON.stringify({ fixture: true }),
		});
		expect(await json.json()).toMatchObject({ data: { input: { fixture: true } } });
		const text = await request("body-text", {
			method: "POST",
			headers: { "Content-Type": "text/plain" },
			rawBody: "sandbox",
		});
		expect(await text.json()).toMatchObject({ data: { text: "sandbox", length: 7 } });
		const bytes = new Uint8Array([0, 255, 1, 254]);
		const binary = await request("body-bytes", {
			method: "POST",
			headers: { "Content-Type": "application/octet-stream" },
			rawBody: bytes,
		});
		expect(await binary.json()).toMatchObject({ data: { bytes: [...bytes] } });
		const none = await request("body-none", { method: "GET" });
		expect(await none.json()).toMatchObject({ data: { method: "GET" } });
		const raw = await request("raw-text", { method: "GET" });
		expect(raw.headers.get("content-type")).toBe("text/plain; charset=utf-8");
		expect(await raw.text()).toBe("marketplace-test");
		const image = await request("fixture-image", { method: "GET" });
		expect(image.headers.get("content-type")).toBe("image/png");
		expect(new Uint8Array(await image.arrayBuffer()).subarray(0, 8)).toEqual(
			Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10),
		);
		const rejected = await request("body-text", { method: "PUT", rawBody: "no" });
		expect(rejected.status).toBe(405);
		expect(rejected.headers.get("allow")).toBe("POST");
	});
});
