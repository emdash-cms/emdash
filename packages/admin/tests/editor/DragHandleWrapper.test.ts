import { describe, expect, it } from "vitest";

import { _getDragHandlePlacement } from "../../src/components/editor/DragHandleWrapper";

describe("DragHandleWrapper", () => {
	it("places controls at the content's logical start edge", () => {
		expect(_getDragHandlePlacement("ltr")).toBe("left-start");
		expect(_getDragHandlePlacement("rtl")).toBe("right-start");
	});
});
