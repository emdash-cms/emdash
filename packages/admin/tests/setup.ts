import "vitest-browser-react";
import { i18n } from "@lingui/core";
import { afterAll, beforeAll } from "vitest";

// Initialize i18n for browser tests with empty English messages
i18n.loadAndActivate({ locale: "en", messages: {} });

const POINTER_MEDIA = [
	"(hover: hover)",
	"(hover: none)",
	"(pointer: fine)",
	"(pointer: coarse)",
	"(pointer: none)",
];
// Test files can mock matchMedia, so keep the page's own.
const pageMatchMedia = window.matchMedia.bind(window);

function pointerMedia() {
	return POINTER_MEDIA.filter((query) => pageMatchMedia(query).matches).join(" and ");
}

// Later test files run on the same page and inherit its hover and pointer.
let pointerMediaAtStart = "";
beforeAll(() => {
	pointerMediaAtStart = pointerMedia();
});
afterAll(() => {
	const now = pointerMedia();
	if (now === pointerMediaAtStart) return;
	throw new Error(
		`This test file changed the page from ${pointerMediaAtStart} to ${now}, and later test files on the page inherit that. Turning touch emulation off resets hover and pointer to the machine's own devices, none on Linux CI. Put touch-screen tests in a .touch.test.tsx file.`,
	);
});
