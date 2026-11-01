import { expect, it } from "vitest";

import "../../dist/styles.css";
import { SeoImageField } from "../../src/components/SeoImageField.js";
import { render } from "../utils/render.js";
import { actionStates, loadedPreview, solidImage } from "../utils/seo-image-field.js";

it("always shows the image actions on touch screens", async () => {
	expect(matchMedia("(pointer: coarse)").matches).toBe(true);
	const screen = await render(
		<div style={{ width: 320 }}>
			<SeoImageField
				seo={{
					title: null,
					description: null,
					image: solidImage(1600, 840),
					canonical: null,
					noIndex: false,
				}}
				onChange={() => {}}
			/>
		</div>,
	);
	await loadedPreview(screen);

	await expect.poll(() => actionStates(screen)).toEqual(["shown", "shown"]);
});
