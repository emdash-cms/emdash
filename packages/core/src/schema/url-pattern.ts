const URL_PARAM_PATTERN = /\{(\w+)\}/g;

export function compileUrlPattern(pattern: string): { regex: RegExp; paramNames: string[] } {
	const paramNames: string[] = [];
	const regexSource = pattern.replace(URL_PARAM_PATTERN, (_match, name: string) => {
		paramNames.push(name);
		return "([^/]+)";
	});

	return { regex: new RegExp(`^${regexSource}$`), paramNames };
}
