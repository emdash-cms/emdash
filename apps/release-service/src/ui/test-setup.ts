import { cleanup } from "@testing-library/react";
import { afterEach } from "vitest";

class ResizeObserverStub {
	disconnect(): void {}
	observe(): void {}
	unobserve(): void {}
}

globalThis.ResizeObserver = ResizeObserverStub;

afterEach(() => {
	cleanup();
});
