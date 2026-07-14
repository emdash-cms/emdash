import { expect, vi } from "vitest";
import type { AxeMatchers } from "vitest-axe";
import * as matchers from "vitest-axe/matchers";

expect.extend(matchers);

declare module "vitest" {
	// eslint-disable-next-line typescript/no-explicit-any -- match vitest's own Assertion<T = any>.
	interface Assertion<T = any> extends AxeMatchers {}
	interface AsymmetricMatchersContaining extends AxeMatchers {}
}

if (!window.matchMedia) {
	window.matchMedia = (query: string): MediaQueryList => ({
		matches: false,
		media: query,
		onchange: null,
		addListener: vi.fn(),
		removeListener: vi.fn(),
		addEventListener: vi.fn(),
		removeEventListener: vi.fn(),
		dispatchEvent: vi.fn(() => false),
	});
}

if (!globalThis.ResizeObserver) {
	globalThis.ResizeObserver = class {
		observe() {}
		unobserve() {}
		disconnect() {}
	};
}

if (!Element.prototype.getAnimations) {
	Element.prototype.getAnimations = () => [];
}
