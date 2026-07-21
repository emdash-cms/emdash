import { describe, expect, test } from "vitest";

import { resolveClassification } from "../../.flue/lib/classifier-client.js";
import { classifierCommands } from "../../.flue/lib/router.js";

const commands = classifierCommands("working");

describe("resolveClassification", () => {
	test("rejects a missing structured result", () => {
		expect(resolveClassification(undefined, commands)).toEqual({
			kind: "error",
			error: "classifier returned no structured result",
		});
	});

	test("maps none without guessing an event", () => {
		expect(
			resolveClassification(
				{ event: "none", arg: null, reasoning: "The comment only asks a question" },
				commands,
			),
		).toEqual({ kind: "none", reasoning: "The comment only asks a question" });
	});

	test("rejects events outside the available command set", () => {
		expect(
			resolveClassification(
				{ event: "confirm", arg: null, reasoning: "The comment says confirm" },
				commands,
			),
		).toEqual({ kind: "error", error: 'classifier returned unknown event "confirm"' });
	});

	test("maps a known event and directive", () => {
		const event = commands[0];
		expect(event).toBeDefined();
		if (!event) return;
		expect(
			resolveClassification(
				{
					event: event.event,
					arg: "try SQLite",
					reasoning: "The comment asks for another attempt",
				},
				commands,
			),
		).toEqual({
			kind: "event",
			event: event.event,
			arg: "try SQLite",
			reasoning: "The comment asks for another attempt",
		});
	});
});
