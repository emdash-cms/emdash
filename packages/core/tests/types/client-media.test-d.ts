import { describe, expectTypeOf, it } from "vitest";

import type { EmDashClient } from "../../src/client/index.js";

type Uploaded = Awaited<ReturnType<EmDashClient["mediaUpload"]>>;
type Listed = Awaited<ReturnType<EmDashClient["mediaList"]>>["items"][number];
type Fetched = Awaited<ReturnType<EmDashClient["mediaGet"]>>;

describe("EmDashClient media items", () => {
	it("type the storage key and file URL of uploaded and listed items", () => {
		expectTypeOf<Uploaded["storageKey"]>().toEqualTypeOf<string>();
		expectTypeOf<Uploaded["url"]>().toEqualTypeOf<string>();
		expectTypeOf<Listed["storageKey"]>().toEqualTypeOf<string>();
		expectTypeOf<Listed["url"]>().toEqualTypeOf<string>();
	});

	it("type unset metadata as null", () => {
		expectTypeOf<Fetched["alt"]>().toEqualTypeOf<string | null>();
		expectTypeOf<Fetched["width"]>().toEqualTypeOf<number | null>();
		expectTypeOf<Fetched["size"]>().toEqualTypeOf<number | null>();
	});

	it("do not offer fields that a fetched item lacks", () => {
		expectTypeOf<Fetched>().not.toHaveProperty("url");
		expectTypeOf<Fetched>().not.toHaveProperty("key");
		expectTypeOf<Fetched>().not.toHaveProperty("updatedAt");
	});
});
