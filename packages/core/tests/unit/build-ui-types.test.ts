import { describe, expect, it } from "vitest";

import { convertUiComponentToTSX } from "../../build-ui-types.js";

describe("UI declaration compilation", () => {
	it.each([
		String.raw`C:\test\x.astro`,
		"C:/test/x.astro",
		String.raw`\\server\share\test\x.astro`,
		"/test/x.astro",
	])("compiles a component with filename %s", async (filename) => {
		const { code, diagnostics, map } = await convertUiComponentToTSX(
			"---\nexport interface Props { title: string }\n---\n<div>{Astro.props.title}</div>",
			filename,
		);

		expect(diagnostics.filter(({ severity }) => Number(severity) === 1)).toEqual([]);
		expect(code).toContain("export interface Props");
		expect(map.sources).toEqual([filename.replaceAll("\\", "/")]);
	});
});
