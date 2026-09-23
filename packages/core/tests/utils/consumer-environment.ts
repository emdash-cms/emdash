export function consumerEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
	const environment = { ...process.env, ...overrides };
	for (const key of Object.keys(environment)) {
		if (key === "VITEST" || key.startsWith("VITEST_")) delete environment[key];
	}
	return environment;
}
