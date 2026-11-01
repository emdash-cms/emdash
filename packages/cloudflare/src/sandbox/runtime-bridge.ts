import { AsyncLocalStorage } from "node:async_hooks";

import { RpcTarget } from "cloudflare:workers";
import type {
	ContentActionCallbacks,
	ContentCreateOptions,
	I18nConfig,
	PluginComment,
	PluginCommentStatus,
	PluginContentItem,
	SandboxCommentModerateCallback,
	SandboxContentCreateCallback,
	SandboxOptions,
	TaxonomyAccessWithWrite,
} from "emdash";

const COLLECTION_NAME_REGEX = /^[a-z][a-z0-9_]*$/;
const COMMENT_STATUSES = new Set<string>(["approved", "pending", "spam"]);
const CONTENT_ACTION_ERROR_CODE_REGEX = /^[A-Z][A-Z0-9_]*$/;
const CONTENT_CREATE_ERROR_CODES = new Set([
	"CONFLICT",
	"NOT_FOUND",
	"SAVE_REJECTED",
	"VALIDATION_ERROR",
]);

function invalidCommentStatus(value: string, name: string): string | null {
	return COMMENT_STATUSES.has(value) ? null : `${name} must be one of: approved, pending, spam`;
}

async function resolveLocale(
	locale: string | undefined,
	config: I18nConfig | null,
): Promise<string> {
	const { resolveContentCreateLocale } = await import("emdash/internal/plugins/host");
	return resolveContentCreateLocale(locale, config);
}

async function forwardContentAction<T>(fn: () => Promise<T>): Promise<T | Record<string, unknown>> {
	try {
		return await fn();
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			typeof error.code === "string" &&
			CONTENT_ACTION_ERROR_CODE_REGEX.test(error.code)
		) {
			return {
				__emdashContentActionError: true,
				error: { code: error.code, message: error.message },
			};
		}
		throw error;
	}
}

export class PluginRuntimeBridge extends RpcTarget {
	// RPC callbacks enter a fresh async context, but the runtime DB is request-scoped.
	#runInContext = AsyncLocalStorage.snapshot();
	#pluginId: string;
	#capabilities: string[];
	#invocationId: string;
	#contentCreate: SandboxContentCreateCallback | null;
	#contentActions: ContentActionCallbacks | null;
	#taxonomyWrite: TaxonomyAccessWithWrite | null;
	#commentModerate: SandboxCommentModerateCallback | null;
	#i18nConfig: I18nConfig | null;
	#beforeContentWrite: SandboxOptions["beforeContentWrite"];

	constructor(
		pluginId: string,
		capabilities: string[],
		invocationId: string,
		callbacks: {
			contentCreate?: SandboxContentCreateCallback | null;
			contentActions?: ContentActionCallbacks | null;
			taxonomyWrite?: TaxonomyAccessWithWrite | null;
			commentModerate?: SandboxCommentModerateCallback | null;
			i18nConfig?: I18nConfig | null;
			beforeContentWrite?: SandboxOptions["beforeContentWrite"];
		},
	) {
		super();
		this.#pluginId = pluginId;
		this.#capabilities = capabilities;
		this.#invocationId = invocationId;
		this.#contentCreate = callbacks.contentCreate ?? null;
		this.#contentActions = callbacks.contentActions ?? null;
		this.#taxonomyWrite = callbacks.taxonomyWrite ?? null;
		this.#commentModerate = callbacks.commentModerate ?? null;
		this.#i18nConfig = callbacks.i18nConfig ?? null;
		this.#beforeContentWrite = callbacks.beforeContentWrite;
	}

	#requireCapability(capability: string): void {
		if (!this.#capabilities.includes(capability)) {
			throw new Error(`Missing capability: ${capability}`);
		}
	}

	#validateCollection(collection: string): void {
		if (!COLLECTION_NAME_REGEX.test(collection)) {
			throw new Error(`Invalid collection name: ${collection}`);
		}
	}

	async contentCreate(
		collection: string,
		data: Record<string, unknown>,
		options?: ContentCreateOptions,
		originHookInput?: string,
	): Promise<
		| PluginContentItem
		| { __emdashContentCreateError: true; error: { code: string; message: string } }
	> {
		this.#requireCapability("content:write");
		this.#validateCollection(collection);
		let locale: string;
		try {
			locale = await resolveLocale(options?.locale, this.#i18nConfig);
		} catch (error) {
			return {
				__emdashContentCreateError: true,
				error: {
					code: "VALIDATION_ERROR",
					message: error instanceof Error ? error.message : "Invalid locale",
				},
			};
		}
		if (!this.#contentCreate) throw new Error("Content creation is not configured");
		const originHook =
			originHookInput === "content:beforeSave" || originHookInput === "content:afterSave"
				? originHookInput
				: undefined;
		try {
			return await this.#runInContext(async () => {
				const recordWrite = await this.#beforeContentWrite?.();
				const created = await this.#contentCreate!(this.#pluginId, collection, data, {
					locale,
					translationOf: options?.translationOf,
					originHook,
					sandboxOrigin: true,
				});
				if (recordWrite) await recordWrite();
				return created;
			});
		} catch (error) {
			const { createSandboxRouteError, getSandboxRouteErrorDetails } =
				await import("emdash/internal/plugins/host");
			const fenceError = getSandboxRouteErrorDetails(error);
			if (fenceError) throw createSandboxRouteError(fenceError.code);
			const code =
				typeof error === "object" && error !== null && "code" in error ? error.code : undefined;
			if (typeof code === "string" && CONTENT_CREATE_ERROR_CODES.has(code)) {
				return {
					__emdashContentCreateError: true,
					error: {
						code,
						message: error instanceof Error ? error.message : "Content create failed",
					},
				};
			}
			throw error;
		}
	}

	#requireContentActions(
		capability: "content:publish" | "content:restore",
	): ContentActionCallbacks {
		this.#requireCapability(capability);
		if (!this.#contentActions) throw new Error("Content actions are not configured");
		return this.#contentActions;
	}

	contentGetVersioned(collection: string, id: string) {
		this.#validateCollection(collection);
		return forwardContentAction(() =>
			this.#runInContext(() =>
				this.#requireContentActions("content:publish").getVersioned(this.#pluginId, collection, id),
			),
		);
	}

	contentPublish(collection: string, id: string, revision: string, _invocationId?: string) {
		this.#validateCollection(collection);
		return forwardContentAction(() =>
			this.#runInContext(() =>
				this.#requireContentActions("content:publish").publish(
					this.#pluginId,
					collection,
					id,
					{ _rev: revision },
					this.#invocationId,
				),
			),
		);
	}

	contentUnpublish(collection: string, id: string, revision: string, _invocationId?: string) {
		this.#validateCollection(collection);
		return forwardContentAction(() =>
			this.#runInContext(() =>
				this.#requireContentActions("content:publish").unpublish(
					this.#pluginId,
					collection,
					id,
					{ _rev: revision },
					this.#invocationId,
				),
			),
		);
	}

	contentSchedule(
		collection: string,
		id: string,
		scheduledAt: string,
		revision: string,
		_invocationId?: string,
	) {
		this.#validateCollection(collection);
		return forwardContentAction(() =>
			this.#runInContext(() =>
				this.#requireContentActions("content:publish").schedule(
					this.#pluginId,
					collection,
					id,
					{ scheduledAt, _rev: revision },
					this.#invocationId,
				),
			),
		);
	}

	contentUnschedule(collection: string, id: string, revision: string, _invocationId?: string) {
		this.#validateCollection(collection);
		return forwardContentAction(() =>
			this.#runInContext(() =>
				this.#requireContentActions("content:publish").unschedule(
					this.#pluginId,
					collection,
					id,
					{ _rev: revision },
					this.#invocationId,
				),
			),
		);
	}

	contentGetTrashedVersioned(collection: string, id: string) {
		this.#validateCollection(collection);
		return forwardContentAction(() =>
			this.#runInContext(() =>
				this.#requireContentActions("content:restore").getTrashedVersioned(
					this.#pluginId,
					collection,
					id,
				),
			),
		);
	}

	contentRestore(collection: string, id: string, revision: string, _invocationId?: string) {
		this.#validateCollection(collection);
		return forwardContentAction(() =>
			this.#runInContext(() =>
				this.#requireContentActions("content:restore").restore(
					this.#pluginId,
					collection,
					id,
					{ _rev: revision },
					this.#invocationId,
				),
			),
		);
	}

	taxonomyCreateTerm(
		taxonomy: string,
		input: Parameters<TaxonomyAccessWithWrite["createTerm"]>[1],
	) {
		this.#requireCapability("taxonomies:write");
		if (!this.#taxonomyWrite) throw new Error("Taxonomy mutations are not available");
		return this.#runInContext(() => this.#taxonomyWrite!.createTerm(taxonomy, input));
	}

	taxonomyAddEntryTerms(collection: string, entryId: string, taxonomy: string, termIds: string[]) {
		this.#validateCollection(collection);
		this.#requireCapability("taxonomies:write");
		if (!this.#taxonomyWrite) throw new Error("Taxonomy mutations are not available");
		return this.#runInContext(() =>
			this.#taxonomyWrite!.addEntryTerms(collection, entryId, taxonomy, termIds),
		);
	}

	taxonomyRemoveEntryTerms(
		collection: string,
		entryId: string,
		taxonomy: string,
		termIds: string[],
	) {
		this.#validateCollection(collection);
		this.#requireCapability("taxonomies:write");
		if (!this.#taxonomyWrite) throw new Error("Taxonomy mutations are not available");
		return this.#runInContext(() =>
			this.#taxonomyWrite!.removeEntryTerms(collection, entryId, taxonomy, termIds),
		);
	}

	async commentSetStatus(
		id: string,
		status: PluginCommentStatus,
		expectedStatus: PluginCommentStatus,
	): Promise<
		| PluginComment
		| {
				__emdashCommentError: {
					code:
						| "COMMENT_STATUS_CONFLICT"
						| "COMMENT_MODERATION_IN_PROGRESS"
						| "COMMENT_STATUS_INVALID";
					message: string;
					currentStatus?: string;
				};
		  }
	> {
		this.#requireCapability("comments:moderate");
		const invalid =
			invalidCommentStatus(status, "status") ??
			invalidCommentStatus(expectedStatus, "expectedStatus");
		if (invalid)
			return { __emdashCommentError: { code: "COMMENT_STATUS_INVALID", message: invalid } };
		if (!this.#commentModerate) throw new Error("Comment moderation is unavailable");
		try {
			return await this.#runInContext(() =>
				this.#commentModerate!(this.#pluginId, id, status, expectedStatus),
			);
		} catch (error) {
			if (typeof error === "object" && error !== null && "code" in error) {
				const code = error.code;
				const currentStatus = "currentStatus" in error ? error.currentStatus : undefined;
				if (
					(code === "COMMENT_STATUS_CONFLICT" && typeof currentStatus === "string") ||
					code === "COMMENT_MODERATION_IN_PROGRESS"
				) {
					return {
						__emdashCommentError: {
							code,
							message: error instanceof Error ? error.message : "Comment moderation failed",
							...(typeof currentStatus === "string" ? { currentStatus } : {}),
						},
					};
				}
			}
			throw error;
		}
	}
}
