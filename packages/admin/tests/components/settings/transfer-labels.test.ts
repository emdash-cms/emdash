import { i18n } from "@lingui/core";
import { describe, expect, it } from "vitest";

import { RECORD_KINDS } from "../../../../core/src/transfer/format/kinds.js";
import {
	EXPORT_TRANSFORMATION_CODES,
	IMPORT_TRANSFORMATION_CODES,
} from "../../../../core/src/transfer/format/transformations.js";
import {
	RECORD_KIND_ORDER,
	recordKindLabel,
	transformationLabel,
} from "../../../src/components/settings/transfer/labels.js";

describe("recordKindLabel", () => {
	it.each([...RECORD_KINDS])("labels the %s record kind", (kind) => {
		expect(recordKindLabel(i18n, kind)).not.toBe(kind);
	});

	it("lists kinds in package order", () => {
		expect(RECORD_KIND_ORDER).toEqual([...RECORD_KINDS]);
	});
});

describe("transformationLabel", () => {
	it.each([...EXPORT_TRANSFORMATION_CODES, ...IMPORT_TRANSFORMATION_CODES])(
		"labels the %s transformation",
		(code) => {
			expect(transformationLabel(i18n, code)).not.toBe(code);
		},
	);
});
