import { describe, expect, it } from "vitest";

import { entriesBetween, fetchChangelogRange } from "../src/changelog.js";

const CHANGELOG = `# emdash

## 1.2.0

### Minor Changes

- [#12](https://github.com/emdash-cms/emdash/pull/12) [\`abc1234\`](https://github.com/emdash-cms/emdash/commit/abc1234) Thanks [@author](https://github.com/author)! - Adds a feature with setup work.

  Keep this second paragraph because it contains the operational detail.

### Patch Changes

- Fixes the existing behavior.

- Updated dependencies [[\`abc1234\`](https://github.com/emdash-cms/emdash/commit/abc1234)]:
  - @emdash-cms/auth@1.2.0

## 1.2.0-rc.1

### Patch Changes

- Prerelease copy.

## 1.0.0

### Major Changes

- Initial stable release.
`;

describe("release changelog", () => {
	it("keeps complete authored entries and removes generated Changesets structure", () => {
		const entries = entriesBetween(CHANGELOG, "1.0.0", "1.2.0");

		expect(entries).toHaveLength(2);
		expect(entries[0]).toMatchObject({
			version: "1.2.0",
			category: "minor",
			source: "[#12](https://github.com/emdash-cms/emdash/pull/12)",
		});
		expect(entries[0]?.body).toContain("Keep this second paragraph");
		expect(entries.map((entry) => entry.body).join("\n")).not.toContain("Updated dependencies");
		expect(entries.map((entry) => entry.body).join("\n")).not.toContain("Prerelease copy");
		expect(entries.map((entry) => entry.body).join("\n")).not.toContain("Thanks");
	});

	it("follows chained archives until it reaches the installed version", async () => {
		const files = new Map([
			[
				"packages/core/CHANGELOG.md",
				"# emdash\n\n<!-- emdash-changelog-archive: ./changelog/1.0.0-to-1.2.0.md -->\n\n## 1.3.0\n\n### Minor Changes\n\n- New API.\n",
			],
			[
				"packages/core/changelog/1.0.0-to-1.2.0.md",
				"# emdash changelog archive\n\n## 1.2.0\n\n### Patch Changes\n\n- Upgrade detail.\n\n## 1.0.0\n\n### Major Changes\n\n- Initial.\n",
			],
		]);
		const requested: string[] = [];
		const fetcher: typeof fetch = async (input) => {
			const url = new URL(
				typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
			);
			const path = decodeURIComponent(url.pathname.split("/contents/")[1] ?? "");
			requested.push(path);
			const content = files.get(path);
			return new Response(
				JSON.stringify({
					encoding: "base64",
					content: Buffer.from(content ?? "").toString("base64"),
				}),
				{ status: content ? 200 : 404 },
			);
		};

		const entries = await fetchChangelogRange(
			{ owner: "emdash-cms", repo: "emdash", directory: "packages/core" },
			"emdash",
			"1.0.0",
			"1.3.0",
			fetcher,
		);

		expect(requested).toEqual([
			"packages/core/CHANGELOG.md",
			"packages/core/changelog/1.0.0-to-1.2.0.md",
		]);
		expect(entries.map((entry) => entry.body)).toEqual(["New API.", "Upgrade detail."]);
	});

	it("fails when the available changelog chain cannot cover the installed version", async () => {
		const changelog =
			"# emdash\n\n## 1.3.0\n\n### Minor Changes\n\n- New API.\n\n## 1.2.0\n\n### Patch Changes\n\n- Fix.\n";
		const fetcher: typeof fetch = async () =>
			new Response(
				JSON.stringify({ encoding: "base64", content: Buffer.from(changelog).toString("base64") }),
			);

		await expect(
			fetchChangelogRange(
				{ owner: "emdash-cms", repo: "emdash", directory: "packages/core" },
				"emdash",
				"1.0.0",
				"1.3.0",
				fetcher,
			),
		).rejects.toThrow("does not reach the installed 1.0.0");
	});
});
