type LogLevel = "info" | "warn" | "error";

export function logEvent(
	level: LogLevel,
	event: string,
	details: Record<string, string | number | boolean | null> = {},
): void {
	const payload = JSON.stringify({
		level,
		event,
		timestamp: new Date().toISOString(),
		...details,
	});

	if (level === "error") {
		console.error(payload);
		return;
	}
	if (level === "warn") {
		console.warn(payload);
		return;
	}
	console.log(payload);
}
