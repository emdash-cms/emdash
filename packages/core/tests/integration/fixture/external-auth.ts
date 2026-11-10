export async function authenticate(): Promise<never> {
	throw new Error("External auth must not be called by the dev server");
}
