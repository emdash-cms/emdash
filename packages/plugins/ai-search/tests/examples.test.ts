import { describe, expect, it } from "vitest";

import { listExamples } from "../src/examples.js";
import { byline, entry, fakeEmDash } from "./fakes.js";

describe("listExamples", () => {
	it("shows each entry at its public path", async () => {
		const deps = fakeEmDash({ entries: [entry()] });

		const examples = await listExamples(deps, "posts", undefined);

		expect(examples).toEqual([{ id: "entry-1", title: "Hello world", url: "/posts/hello-world" }]);
	});

	it("marks entries without a public address", async () => {
		const deps = fakeEmDash({ entries: [entry({ slug: null })] });

		const [example] = await listExamples(deps, "posts", undefined);

		expect(example).toMatchObject({ title: "Hello world", url: null });
	});

	it("shows authors at the address template being checked", async () => {
		const deps = fakeEmDash({ bylines: [byline()] });

		const examples = await listExamples(deps, "_authors", "/people/{slug}");

		expect(examples).toEqual([{ id: "byline-1", title: "Jane Doe", url: "/people/jane-doe" }]);
	});
});
