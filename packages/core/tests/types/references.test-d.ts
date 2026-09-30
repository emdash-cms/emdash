import { describe, expectTypeOf, it } from "vitest";

import { getEmDashEntry, type ReferencePage } from "../../src/query.js";

interface Author {
	id: string;
	name: string;
}

interface Post {
	id: string;
	title: string;
}

// What `generateTypesFile` emits for a collection with two bound reference
// fields, one pointing at another collection and one at itself.
declare module "../../src/query.js" {
	interface EmDashCollections {
		posts: Post;
		authors: Author;
	}
	interface EmDashCollectionReferences {
		posts: { author: ReferencePage<Author>; related_posts: ReferencePage<Post> };
	}
}

describe("getEmDashEntry references", () => {
	it("resolves a selected field to the target collection's interface", async () => {
		const { entry } = await getEmDashEntry("posts", "slug", { references: { author: true } });
		expectTypeOf(entry!.references!.author.entries[0]!.data).toEqualTypeOf<Author>();
	});

	it("narrows to the fields the caller named", async () => {
		const { entry } = await getEmDashEntry("posts", "slug", { references: { author: true } });
		expectTypeOf(entry!.references!).toEqualTypeOf<{ author: ReferencePage<Author> }>();
	});

	it("rejects a field the collection does not have", async () => {
		await getEmDashEntry("posts", "slug", {
			// @ts-expect-error - `nope` is not a reference field on posts
			references: { nope: true },
		});
	});

	it("leaves an unregistered collection's pages un-narrowed", async () => {
		const { entry } = await getEmDashEntry("widgets", "slug", { references: { anything: true } });
		expectTypeOf(entry!.references!.anything).toEqualTypeOf<ReferencePage>();
	});

	it("keeps the data parameter second, for resolveEmDashPath's explicit call", async () => {
		const { entry } = await getEmDashEntry<string, Post>("posts", "slug");
		expectTypeOf(entry!.data).toEqualTypeOf<Post>();
	});
});
