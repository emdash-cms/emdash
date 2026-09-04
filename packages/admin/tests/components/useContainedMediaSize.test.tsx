import * as React from "react";
import { describe, expect, it } from "vitest";

import { useContainedMediaSize } from "../../src/components/useContainedMediaSize.js";
import { render } from "../utils/render.tsx";

function Harness() {
	const frameRef = React.useRef<HTMLDivElement>(null);
	const size = useContainedMediaSize(frameRef, { width: 400, height: 200 });

	return (
		<div style={{ transform: "scale(0.9)" }}>
			<div ref={frameRef} style={{ width: 400, height: 200 }}>
				<output aria-label="Contained size">
					{size ? `${size.width} × ${size.height}` : "Pending"}
				</output>
			</div>
		</div>
	);
}

describe("useContainedMediaSize", () => {
	it("uses the frame layout size while an ancestor is transformed", async () => {
		const screen = await render(<Harness />);

		await expect.element(screen.getByLabelText("Contained size")).toHaveTextContent("400 × 200");
	});
});
