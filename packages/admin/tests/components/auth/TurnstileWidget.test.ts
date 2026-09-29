import { describe, expect, it } from "vitest";

import { toTurnstileLanguage } from "../../../src/components/auth/TurnstileWidget";

describe("toTurnstileLanguage", () => {
	it("maps admin locales to languages the Turnstile widget accepts", () => {
		expect(toTurnstileLanguage("en")).toBe("en");
		expect(toTurnstileLanguage("en-GB")).toBe("en");
		expect(toTurnstileLanguage("pt-BR")).toBe("pt-br");
		expect(toTurnstileLanguage("zh-TW")).toBe("zh-tw");
		expect(toTurnstileLanguage("es-419")).toBe("es");
		expect(toTurnstileLanguage("sr-Latn")).toBe("sr");
	});

	it("falls back to the browser language for locales Turnstile doesn't support", () => {
		expect(toTurnstileLanguage("eu")).toBe("auto");
		expect(toTurnstileLanguage("ka")).toBe("auto");
		expect(toTurnstileLanguage("pseudo")).toBe("auto");
	});
});
