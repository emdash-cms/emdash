import { expect, it } from "vitest";

import { normalizeSourcePath } from "../../../src/redirects/patterns.js";
import {
	canonicalImportSource,
	importSourceKey,
	importSourceLookupVariants,
} from "../../../src/redirects/source-paths.js";

it.each([
	["/literal%2541/", "/literal%2541"],
	["/%63ontact/literal%2541/", "/contact/literal%2541"],
	["/%d0%bf%d1%80/", "/%D0%BF%D1%80"],
	["/old/%5Bslug%5D/", "/old/[slug]"],
])("stores %s in a stable spelling without changing its lookup key", (raw, stored) => {
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
