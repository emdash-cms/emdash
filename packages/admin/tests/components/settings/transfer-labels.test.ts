import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
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

	it("translates the principal kind separately from other Authors labels", () => {
		const pluginAuthors = msg`Authors`;
		const principal = msg({
			message: "Authors",
			context: "site transfer record kind: user accounts",
		});
		i18n.loadAndActivate({
			locale: "pl",
			messages: { [pluginAuthors.id]: "Autorzy", [principal.id]: "Konta autorów" },
		});
		try {
			expect(recordKindLabel(i18n, "principal")).toBe("Konta autorów");
			expect(i18n._(pluginAuthors)).toBe("Autorzy");
		} finally {
			i18n.loadAndActivate({ locale: "en", messages: {} });
		}
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
