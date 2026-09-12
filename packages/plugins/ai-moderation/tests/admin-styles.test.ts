import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

/**
 * The admin stylesheet (@emdash-cms/admin/dist/styles.css) is precompiled from
 * the admin package and the Kumo design system only: classes used by plugin
 * admin modules are not scanned. shadcn-style semantic utilities such as
 * `bg-background` or `bg-primary` therefore produce no CSS at all, which is how
 * the "Edit Category" dialog ended up transparent. Only Kumo tokens
 * (`bg-kumo-*`, `text-kumo-*`, `border-kumo-*`) are guaranteed to exist.
 */
const SHADCN_UTILITIES = [
	"bg-background",
	"bg-foreground",
	"bg-primary",
	"text-primary",
	"text-primary-foreground",
	"text-muted-foreground",
	"bg-secondary",
	"bg-muted",
	"bg-accent",
	"bg-card",
	"bg-popover",
	"border-input",
];

const adminSource = readFileSync(
	join(dirname(fileURLToPath(import.meta.url)), "../src/admin.tsx"),
	"utf8",
);

describe("admin.tsx styling", () => {
	it.each(SHADCN_UTILITIES)(
		"does not rely on the %s utility (absent from the admin stylesheet)",
		(utility) => {
			const pattern = new RegExp(`(^|[\\s"'\`:])${utility}(?=$|[\\s"'\`/])`, "m");
			expect(adminSource).not.toMatch(pattern);
		},
	);
});
