// Lets Node's type stripping load .flue modules, which import siblings by
// their emitted ".js" names.
import { registerHooks } from "node:module";

registerHooks({
	resolve(specifier, context, next) {
		try {
			return next(specifier, context);
		} catch (error) {
			if (specifier.startsWith(".") && specifier.endsWith(".js")) {
				return next(`${specifier.slice(0, -3)}.ts`, context);
			}
			throw error;
		}
	},
});
