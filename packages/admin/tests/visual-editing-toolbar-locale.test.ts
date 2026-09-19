import { setupI18n } from "@lingui/core";
import { describe, expect, it } from "vitest";

import { translateVisualEditingToolbarLabels } from "../src/locales/server.js";

describe("visual editing toolbar localization", () => {
	it("resolves every publication state label from the active Lingui catalog", () => {
		const i18n = setupI18n();
		i18n.load("es", {
			"visualEditing.publish": "Publicar",
			"visualEditing.publishing": "Publicando…",
			"visualEditing.sessionExpired": "La sesión de edición ha caducado.",
			"visualEditing.refreshPage": "Actualizar página",
			"visualEditing.publishFailed": "No se pudo publicar.",
		});
		i18n.activate("es");

		expect(translateVisualEditingToolbarLabels(i18n)).toEqual({
			publish: "Publicar",
			publishing: "Publicando…",
			sessionExpired: "La sesión de edición ha caducado.",
			refreshPage: "Actualizar página",
			publishFailed: "No se pudo publicar.",
		});
	});
});
