import { describe, expect, it } from "vitest";

import { BundleWorkspace, READ_WINDOW_CHARS, ToolInputError } from "../src/workspace.js";

const TOKEN = "test-token";

describe("BundleWorkspace", () => {
	it("numbers lines and fences file text with the run token", () => {
		const workspace = new BundleWorkspace(
			[{ path: "backend.js", byteLength: 11, text: "one\ntwo\nend" }],
			TOKEN,
		);

		const output = workspace.readFile("backend.js");

		expect(output).toContain("end of file");
		expect(output).toContain(
			`<<<BUNDLE ${TOKEN}>>>\n     1 | one\n     2 | two\n     3 | end\n<<<END BUNDLE ${TOKEN}>>>`,
		);
	});

	it("reports unread text until every window of a large file is read", () => {
		const text = `${"a".repeat(READ_WINDOW_CHARS + 10)}\nlast`;
		const workspace = new BundleWorkspace(
			[
				{ path: "backend.js", byteLength: text.length, text },
				{ path: "icon.png", byteLength: 4 },
			],
			TOKEN,
		);

		const first = workspace.readFile("backend.js");
		expect(first).toContain(`continue with read_file offset ${READ_WINDOW_CHARS}`);
		expect(workspace.unreadRanges()).toEqual([
			`backend.js from offset ${READ_WINDOW_CHARS} of ${text.length}`,
		]);

		const second = workspace.readFile("backend.js", READ_WINDOW_CHARS);
		expect(second).toContain("     1+| aaaaaaaaaa");
		expect(second).toContain("     2 | last");
		expect(workspace.unreadRanges()).toEqual([]);
	});

	it("refuses to read binary or missing files", () => {
		const workspace = new BundleWorkspace([{ path: "icon.png", byteLength: 4 }], TOKEN);

		expect(() => workspace.readFile("icon.png")).toThrow(ToolInputError);
		expect(() => workspace.readFile("missing.js")).toThrow(ToolInputError);
	});

	it("finds matches with their line numbers", () => {
		const workspace = new BundleWorkspace(
			[{ path: "backend.js", byteLength: 30, text: "const a = 1;\nfetch(url);\nFETCH(other);" }],
			TOKEN,
		);

		expect(workspace.search("fetch", {})).toContain("backend.js:2: fetch(url);");
		expect(workspace.search("fetch", { ignoreCase: true })).toContain("2 matches.");
		expect(() => workspace.search("(", { regex: true })).toThrow(ToolInputError);
	});

	it("returns the text of a cited line", () => {
		const workspace = new BundleWorkspace(
			[{ path: "backend.js", byteLength: 7, text: "one\ntwo" }],
			TOKEN,
		);

		expect(workspace.line("backend.js", 2)).toBe("two");
		expect(workspace.line("backend.js", 3)).toBeUndefined();
		expect(workspace.line("other.js", 1)).toBeUndefined();
	});
});
