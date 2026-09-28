const CONTEXT_REGISTRIES = Symbol.for("emdash-bot.contextRegistries");

type RegistryStore = WeakMap<object, Map<string, Map<string, unknown>>>;

export function contextRegistry<T>(name: string, context: object): Map<string, T> {
	const globalStore = globalThis as typeof globalThis & {
		[CONTEXT_REGISTRIES]?: RegistryStore;
	};
	const contexts = (globalStore[CONTEXT_REGISTRIES] ??= new WeakMap());
	let registries = contexts.get(context);
	if (!registries) {
		registries = new Map();
		contexts.set(context, registries);
	}
	let registry = registries.get(name);
	if (!registry) {
		registry = new Map();
		registries.set(name, registry);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- each registry name has one caller-owned value type.
	return registry as Map<string, T>;
}
