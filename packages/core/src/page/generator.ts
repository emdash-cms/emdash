const MAJOR_VERSION_PATTERN = /^(\d+)\./;

export function generatorContent(version: string): string {
	const major = MAJOR_VERSION_PATTERN.exec(version)?.[1];
	return major ? `EmDash ${major}` : "EmDash";
}
