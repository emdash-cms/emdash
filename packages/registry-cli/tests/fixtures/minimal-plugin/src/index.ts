/**
 * Test fixture: descriptor-factory plugin (the "standard" format the bundler
 * recognises without needing any actual `emdash` runtime).
 *
 * The bundler's manifest probe imports this module and calls the default
 * export; the returned object's id+version make it a valid descriptor.
 */
export default function fixturePlugin() {
	return {
		id: "fixture-minimal",
		version: "1.2.3",
		capabilities: ["content:read"],
		allowedHosts: ["api.example.com"],
		storage: {},
	};
}
