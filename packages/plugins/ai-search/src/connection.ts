import type { PluginContext } from "emdash";

import { BindingAiSearch } from "./adapters/binding.js";
import { type RestCredentials, RestAiSearch } from "./adapters/rest.js";
import { ENV } from "./env.js";
import type { AiSearchOptions } from "./options.js";
import type { AiSearchProvider } from "./ports/ai-search.js";

/** Plugin settings holding the REST credentials the environment does not set. */
export const SETTINGS = { accountId: "accountId", apiToken: "apiToken" } as const;

type Env = Record<string, string | undefined>;
type SettingsContext = Pick<PluginContext, "settings">;
type Credentials = { accountId?: string; apiToken?: string };

export interface ConnectionInfo {
	accountId: { source: "env" | "settings" | null; value?: string };
	apiToken: { source: "env" | "settings" | null };
}

/** The binding when there is one, otherwise the REST API when it has credentials. */
export async function openProvider(
	ctx: SettingsContext,
	options: AiSearchOptions,
	sources?: { binding: AiSearchNamespace | null; env: Env },
): Promise<AiSearchProvider | null> {
	const binding = sources ? sources.binding : await readBinding(options);
	if (binding) return new BindingAiSearch(binding, options.instance);
	const env = sources?.env ?? readEnv();
	const fromEnv = { accountId: env[ENV.accountId], apiToken: env[ENV.apiToken] };
	const { accountId, apiToken } =
		fromEnv.accountId && fromEnv.apiToken ? fromEnv : merge(fromEnv, await stored(ctx));
	if (!accountId || !apiToken) return null;
	return new RestAiSearch({ accountId, apiToken, namespace: namespace(env) }, options.instance);
}

export async function describeConnection(
	ctx: SettingsContext,
	env: Env = readEnv(),
): Promise<ConnectionInfo> {
	const saved = await stored(ctx);
	const source = (field: keyof Credentials) => {
		if (env[ENV[field]]) return "env";
		return saved[field] ? "settings" : null;
	};
	const accountId = source("accountId");
	return {
		accountId: {
			source: accountId,
			value: accountId === "settings" ? saved.accountId : undefined,
		},
		apiToken: { source: source("apiToken") },
	};
}

/**
 * Saves the given credentials after checking them, with any not given taken
 * from the environment or settings. Throws the check's `ProviderError`.
 */
export async function saveCredentials(
	ctx: SettingsContext,
	options: AiSearchOptions,
	input: Credentials,
	env: Env = readEnv(),
	connect: (credentials: RestCredentials) => Pick<RestAiSearch, "verify"> = (credentials) =>
		new RestAiSearch(credentials, options.instance),
): Promise<void> {
	const fromEnv = { accountId: env[ENV.accountId], apiToken: env[ENV.apiToken] };
	const { accountId, apiToken } = merge(fromEnv, input, await stored(ctx));
	if (accountId && apiToken) {
		await connect({ accountId, apiToken, namespace: namespace(env) }).verify();
	}
	if (input.accountId) await ctx.settings.set(SETTINGS.accountId, input.accountId);
	if (input.apiToken) await ctx.settings.set(SETTINGS.apiToken, input.apiToken);
}

function merge(...layers: Credentials[]): Credentials {
	return {
		accountId: layers.find((layer) => layer.accountId)?.accountId,
		apiToken: layers.find((layer) => layer.apiToken)?.apiToken,
	};
}

/** Both credentials in one query. A token that cannot be decrypted counts as unset. */
async function stored(ctx: SettingsContext): Promise<Credentials> {
	const entries = await ctx.settings.list().catch((error: unknown) => {
		console.error("[ai-search] could not read the stored AI Search credentials:", error);
		return [];
	});
	const value = (key: string) => {
		const found = entries.find((entry) => entry.key === key)?.value;
		return typeof found === "string" ? found : undefined;
	};
	return { accountId: value(SETTINGS.accountId), apiToken: value(SETTINGS.apiToken) };
}

function namespace(env: Env): string {
	return env[ENV.namespace] || "default";
}

/** EmDash reads secrets from `process.env` on every platform. */
function readEnv(): Env {
	return typeof process !== "undefined" ? process.env : {};
}

/** The `ai_search_namespaces` binding, or null off Workers or when it is not configured. */
async function readBinding(options: AiSearchOptions): Promise<AiSearchNamespace | null> {
	try {
		const { env } = await import("./worker-env.js");
		return (env?.[options.binding] as AiSearchNamespace | undefined) ?? null;
	} catch {
		return null;
	}
}
