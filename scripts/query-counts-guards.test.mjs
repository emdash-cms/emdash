import assert from "node:assert/strict";
import test from "node:test";

import { assertCompleteMeasurements, assertSuccessfulResponse } from "./query-counts-guards.mjs";

const HTTP_ERROR_PATTERN = /GET \/ \(cold\) returned HTTP 500/;
const ZERO_EVENTS_PATTERN = /recorded zero query events/;
const MISSING_PHASE_PATTERN = /GET \/posts \(warm\) has 0 stream-end markers/;
const COUNT_MISMATCH_PATTERN = /GET \/ \(cold\) reports 2 queries but captured 1/;

const routes = [
	["GET", "/"],
	["GET", "/posts"],
];

await test("rejects non-successful route responses", () => {
	assert.throws(() => assertSuccessfulResponse("GET", "/", "cold", 500), HTTP_ERROR_PATTERN);
});

await test("rejects measurements with no query events", () => {
	assert.throws(() => assertCompleteMeasurements([], [], routes), ZERO_EVENTS_PATTERN);
});

await test("rejects measurements missing a route phase", () => {
	const snapshots = [
		{ method: "GET", route: "/", phase: "cold", dbCount: 1 },
		{ method: "GET", route: "/", phase: "warm", dbCount: 0 },
		{ method: "GET", route: "/posts", phase: "cold", dbCount: 0 },
	];

	assert.throws(
		() =>
			assertCompleteMeasurements([{ method: "GET", route: "/", phase: "cold" }], snapshots, routes),
		MISSING_PHASE_PATTERN,
	);
});

await test("rejects query-event truncation", () => {
	const snapshots = routes.flatMap(([method, route]) => [
		{ method, route, phase: "cold", dbCount: route === "/" ? 2 : 0 },
		{ method, route, phase: "warm", dbCount: 0 },
	]);

	assert.throws(
		() =>
			assertCompleteMeasurements([{ method: "GET", route: "/", phase: "cold" }], snapshots, routes),
		COUNT_MISMATCH_PATTERN,
	);
});

await test("accepts complete cold and warm measurements", () => {
	const snapshots = routes.flatMap(([method, route]) => [
		{ method, route, phase: "cold", dbCount: route === "/" ? 1 : 0 },
		{ method, route, phase: "warm", dbCount: 0 },
	]);

	assert.doesNotThrow(() =>
		assertCompleteMeasurements([{ method: "GET", route: "/", phase: "cold" }], snapshots, routes),
	);
});
