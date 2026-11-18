import { expect, it } from "vitest";

import { normalizeSourcePath } from "../../../src/redirects/patterns.js";
import {
	canonicalImportSource,
	importSourceKey,
	importSourceLookupVariants,
	normalizationChangesPath,
} from "../../../src/redirects/source-paths.js";

it.each([
	["/literal%2541/", "/literal%2541"],
	["/%63ontact/literal%2541/", "/contact/literal%2541"],
	["/%d0%bf%d1%80/", "/%D0%BF%D1%80"],
	["/old/%5Bslug%5D/", "/old/[slug]"],
	["/posts/with%20space/", "/posts/with%20space"],
	["/posts/why%3f/", "/posts/why%3f"],
	["/posts/%2509/", "/posts/%2509"],
])("stores %s in a stable spelling without changing its lookup key", (raw, stored) => {
	expect(normalizationChangesPath(raw)).toBe(false);
	expect(canonicalImportSource(raw)).toBe(stored);
	expect(canonicalImportSource(stored)).toBe(stored);
	expect(importSourceKey(stored)).toBe(importSourceKey(raw));
	expect(normalizeSourcePath(stored)).toBe(normalizeSourcePath(raw.slice(0, -1)));
});

it("does not look up another URI layer or an ancestor", () => {
	expect(importSourceLookupVariants(["/literal%2541/"])).not.toContain("/literal%41");
	const variants = importSourceLookupVariants(["/posts/%252e/"]);
	expect(variants).toContain("/posts/%252e");
	expect(variants).not.toContain("/posts");
	expect(variants).not.toContain("/posts/");
});

it.each([
	["/posts/left%09right", "/posts/leftright"],
	["/posts/left%0Aright", "/posts/leftright"],
	["/posts/left%0Dright", "/posts/leftright"],
	["/posts/left%5Cright", "/posts/left/right"],
	["/posts/%09", "/posts"],
	["/posts/%0A", "/posts"],
	["/posts/%0D", "/posts"],
	["/posts/%5C", "/posts"],
	["/posts/%252e", "/posts"],
	["/parent%5C..%5Coverview", "/overview"],
])("does not derive another pathname from %s", (source, other) => {
	expect(normalizationChangesPath(source)).toBe(true);
	expect(canonicalImportSource(source)).toBe(source);
	const variants = importSourceLookupVariants([source]);
	expect(variants).toContain(source);
	expect(variants).not.toContain(other);
	expect(variants).not.toContain(`${other}/`);
});
