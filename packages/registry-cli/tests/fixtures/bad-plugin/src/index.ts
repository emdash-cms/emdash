/**
 * Test fixture: descriptor declares hooks but the package has no sandbox
 * entry. The bundler should hard-fail at validation rather than emit a
 * manifest that promises functionality the bundle can't deliver.
 */
export default function badPlugin() {
	return {
		id: "bad-plugin",
		version: "0.1.0",
		capabilities: ["content:read"],
		allowedHosts: [],
		storage: {},
		// We declare hooks here, but there's no `src/sandbox-entry.ts` and
		// no `./sandbox` package export, so the bundler can't probe for
		// these hook names.
		hooks: ["content:beforeCreate"],
	};
}
