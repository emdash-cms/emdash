const TRACKED_PHASES = ["cold", "warm"];

export function assertSuccessfulResponse(method, path, phase, status) {
	if (status < 200 || status >= 300) {
		throw new Error(`${method} ${path} (${phase}) returned HTTP ${status}`);
	}
}

export function assertCompleteMeasurements(events, streamEndSnapshots, routes) {
	const trackedEvents = events.filter((event) => TRACKED_PHASES.includes(event.phase));
	if (trackedEvents.length === 0) {
		throw new Error("Query-count harness recorded zero query events");
	}

	const eventCounts = new Map();
	for (const event of trackedEvents) {
		const key = `${event.method} ${event.route} (${event.phase})`;
		eventCounts.set(key, (eventCounts.get(key) ?? 0) + 1);
	}
	const snapshots = new Map();
	for (const snapshot of streamEndSnapshots) {
		if (!TRACKED_PHASES.includes(snapshot.phase)) continue;
		const key = `${snapshot.method} ${snapshot.route} (${snapshot.phase})`;
		const entries = snapshots.get(key) ?? [];
		entries.push(snapshot);
		snapshots.set(key, entries);
	}

	const errors = [];
	for (const [method, path] of routes) {
		const route = new URL(path, "http://localhost").pathname;
		for (const phase of TRACKED_PHASES) {
			const key = `${method} ${route} (${phase})`;
			const entries = snapshots.get(key) ?? [];
			if (entries.length !== 1) {
				errors.push(`${key} has ${entries.length} stream-end markers`);
				continue;
			}
			const eventCount = eventCounts.get(key) ?? 0;
			if (entries[0].dbCount !== eventCount) {
				errors.push(`${key} reports ${entries[0].dbCount} queries but captured ${eventCount}`);
			}
		}
	}
	if (errors.length > 0) {
		throw new Error(`Query-count measurements are incomplete: ${errors.join(", ")}`);
	}
}
