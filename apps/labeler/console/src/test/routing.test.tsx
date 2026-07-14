import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { renderRoute } from "./harness.js";

vi.mock("../api/client.js", async () => {
	const actual = await vi.importActual<typeof import("../api/client.js")>("../api/client.js");
	return { ...actual, apiClient: actual.createFixtureClient() };
});

describe("console routing", () => {
	it("renders the NotFound page for an unknown path", async () => {
		renderRoute("/no-such-page");
		expect(await screen.findByRole("heading", { name: "Not found", level: 1 })).toBeTruthy();
	});
});
