import { expect, it } from "vitest";

import { isVirtualDialectUnavailableError } from "../../../src/media/usage/collection-deletion.js";

it("recognizes Node's unsupported virtual URL without swallowing unrelated loader failures", () => {
	const unsupported = Object.assign(
		new Error(
			"Only URLs with a scheme in: file, data, and node are supported by the default ESM loader. Received protocol 'virtual:'",
		),
		{ code: "ERR_UNSUPPORTED_ESM_URL_SCHEME" },
	);
	const unrelated = Object.assign(new Error("Unsupported https URL"), {
		code: "ERR_UNSUPPORTED_ESM_URL_SCHEME",
	});

	expect(isVirtualDialectUnavailableError(unsupported)).toBe(true);
	expect(isVirtualDialectUnavailableError(unrelated)).toBe(false);
});
