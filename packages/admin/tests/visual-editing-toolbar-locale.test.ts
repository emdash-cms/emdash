import { describe, expect, it } from "vitest";

import { translateVisualEditingToolbarLabels } from "../src/locales/server.js";

describe("visual editing toolbar localization", () => {
	it("resolves every publication state label from the active Lingui catalog", () => {
		const messages = {
			"visualEditing.publish": ["Publicar"],
			"visualEditing.publishing": ["Publicando…"],
			"visualEditing.sessionExpired": ["La sesión de edición ha caducado."],
			"visualEditing.refreshPage": ["Actualizar página"],
			"visualEditing.publishFailed": ["No se pudo publicar."],
			"visualEditing.editMode": ["Modo de edición"],
			"visualEditing.openInAdmin": ["Abrir en administración"],
			"visualEditing.hideToolbar": ["Ocultar barra de herramientas"],
		};

		expect(translateVisualEditingToolbarLabels(messages)).toEqual({
			publish: "Publicar",
			publishing: "Publicando…",
			sessionExpired: "La sesión de edición ha caducado.",
			refreshPage: "Actualizar página",
			publishFailed: "No se pudo publicar.",
			editMode: "Modo de edición",
			openInAdmin: "Abrir en administración",
			hideToolbar: "Ocultar barra de herramientas",
		});
	});
});
