import { i18n } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AssessmentState } from "../api/types.js";
import { StateBadge } from "./StateBadge.js";

i18n.loadAndActivate({ locale: "en", messages: {} });

const ALL_STATES: readonly AssessmentState[] = [
	"observed",
	"verifying",
	"pending",
	"running",
	"passed",
	"warned",
	"blocked",
	"error",
	"stale",
	"cancelled",
];

describe("StateBadge", () => {
	it("renders a label for every assessment state", () => {
		for (const state of ALL_STATES) {
			const { unmount } = render(
				<I18nProvider i18n={i18n}>
					<StateBadge state={state} />
				</I18nProvider>,
			);
			expect(screen.getByText(new RegExp(state, "i"))).toBeTruthy();
			unmount();
		}
	});
});
