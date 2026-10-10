import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { afterEach, describe, expect, it } from "vitest";

import { getRoleConfig } from "../../../src/components/users/roleDefinitions.js";

describe("role labels", () => {
	afterEach(() => {
		i18n.loadAndActivate({ locale: "en", messages: {} });
	});

	it("translates the Admin role separately from the Admin navigation and token scope label", () => {
		const adminArea = msg`Admin`;
		const adminRole = getRoleConfig(50).label;
		i18n.loadAndActivate({
			locale: "pl",
			messages: { [adminArea.id]: "Administracja", [adminRole.id]: "Admin" },
		});

		expect(i18n._(adminRole)).toBe("Admin");
		expect(i18n._(adminArea)).toBe("Administracja");
	});
});
