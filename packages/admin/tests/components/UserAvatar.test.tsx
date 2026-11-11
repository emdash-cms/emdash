import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";

import "../../dist/styles.css";
import { UserAvatar } from "../../src/components/UserAvatar.js";
import { render } from "../utils/render.tsx";

const PICTURE =
	"data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
const BROKEN_PICTURE = "data:image/png;base64,AAAA";

const user = { id: "user_1", name: "Noah Pham" };

let stopWatching: (() => void) | undefined;

afterEach(() => {
	stopWatching?.();
	stopWatching = undefined;
});

/** Records the picture's opacity at the moment it finishes loading or fails. */
function watchPictureSettling(event: "load" | "error") {
	const seen: string[] = [];
	const listener = (e: Event) => {
		if (e.target instanceof HTMLImageElement) seen.push(getComputedStyle(e.target).opacity);
	};
	document.addEventListener(event, listener, true);
	stopWatching = () => document.removeEventListener(event, listener, true);
	return seen;
}

function letters(container: HTMLElement) {
	return container.querySelector("svg text")?.textContent ?? "";
}

describe("UserAvatar", () => {
	it("shows the generated avatar until the picture loads, then the picture", async () => {
		const opacityWhenLoaded = watchPictureSettling("load");
		const screen = await render(<UserAvatar user={{ ...user, avatarUrl: PICTURE }} size={32} />);

		expect(letters(screen.container)).toBe("NP");
		await expect.poll(() => opacityWhenLoaded).toEqual(["0"]);
		const picture = screen.container.querySelector("img")!;
		await expect.poll(() => getComputedStyle(picture).opacity).toBe("1");
		// A transparent picture would otherwise show the generated avatar through it.
		expect(screen.container.querySelector("svg")).toBeNull();
	});

	it("keeps the generated avatar when the picture fails to load", async () => {
		const opacityWhenFailed = watchPictureSettling("error");
		const screen = await render(
			<UserAvatar user={{ ...user, avatarUrl: BROKEN_PICTURE }} size={32} />,
		);

		await expect.poll(() => opacityWhenFailed).toEqual(["0"]);
		await expect.poll(() => screen.container.querySelector("img")).toBeNull();
		expect(letters(screen.container)).toBe("NP");
	});

	it("shows the picture again after switching to one that loads", async () => {
		const screen = await render(
			<UserAvatar user={{ ...user, avatarUrl: BROKEN_PICTURE }} size={32} />,
		);
		await expect.poll(() => screen.container.querySelector("img")).toBeNull();

		await screen.rerender(<UserAvatar user={{ ...user, avatarUrl: PICTURE }} size={32} />);
		await expect
			.poll(() => {
				const picture = screen.container.querySelector("img");
				return picture && getComputedStyle(picture).opacity;
			})
			.toBe("1");
	});

	it("shows no letters for a user without a name", async () => {
		const screen = await render(<UserAvatar user={{ id: "user_1", name: "  " }} size={64} />);

		expect(screen.container.querySelector("svg")).not.toBeNull();
		expect(screen.container.textContent).toBe("");
	});

	it("shows only the first initial below 24 px", async () => {
		const screen = await render(
			<>
				<UserAvatar user={user} size={20} />
				<UserAvatar user={user} size={24} />
			</>,
		);

		const [small, regular] = screen.container.querySelectorAll("svg");
		expect(small?.textContent).toBe("N");
		expect(regular?.textContent).toBe("NP");
	});

	it("is hidden from screen readers without a label", async () => {
		const screen = await render(<UserAvatar user={user} size={32} />);

		expect(letters(screen.container)).toBe("NP");
		expect(screen.getByRole("img").query()).toBeNull();
	});

	it("is an image with the given label", async () => {
		const screen = await render(
			<UserAvatar user={{ ...user, avatarUrl: PICTURE }} size={32} label="Noah Pham" />,
		);

		await expect.element(screen.getByRole("img", { name: "Noah Pham" })).toBeVisible();
		expect(screen.getByRole("img").all()).toHaveLength(1);
	});
});
