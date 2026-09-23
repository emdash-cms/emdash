import { i18n } from "@lingui/core";
import { describe, expect, it } from "vitest";

import {
	EXPORT_TRANSFORMATION_CODES,
	IMPORT_TRANSFORMATION_CODES,
} from "../../../../core/src/transfer/format/transformations.js";
import { transformationLabel } from "../../../src/components/settings/transfer/labels.js";

describe("transformationLabel", () => {
	it.each([...EXPORT_TRANSFORMATION_CODES, ...IMPORT_TRANSFORMATION_CODES])(
		"labels the %s transformation",
		(code) => {
			expect(transformationLabel(i18n, code)).not.toBe(code);
		},
	);
});
