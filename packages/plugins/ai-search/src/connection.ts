import { BindingAiSearch } from "./adapters/binding.js";
import type { AiSearchOptions } from "./options.js";
import type { AiSearchProvider } from "./ports/ai-search.js";

/** The AI Search binding, or null off Workers or when it is not configured. */
export async function openProvider(options: AiSearchOptions): Promise<AiSearchProvider | null> {
	const binding = await readBinding(options);
	return binding ? new BindingAiSearch(binding, options.instance) : null;
}

async function readBinding(options: AiSearchOptions): Promise<AiSearchNamespace | null> {
	try {
		const { env } = await import("./worker-env.js");
		const binding: unknown = Reflect.get(env, options.binding);
		return binding ? (binding as AiSearchNamespace) : null;
	} catch {
		return null;
	}
}
