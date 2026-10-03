import type { Messages } from "@lingui/core";
import { describe, expect, it } from "vitest";

import { translateVisualEditingToolbarLabels } from "../src/locales/server.js";

describe("visual editing toolbar localization", () => {
	it("resolves every toolbar label from the active Lingui catalog", () => {
		const messages: Messages = {
			"visualEditing.publish": ["Publicar"],
			"visualEditing.publishing": ["Publicando…"],
			"visualEditing.sessionExpired": ["La sesión de edición ha caducado."],
			"visualEditing.refreshPage": ["Actualizar página"],
			"visualEditing.publishFailed": ["No se pudo publicar."],
			"visualEditing.editMode": ["Modo de edición"],
			"visualEditing.openInAdmin": ["Abrir en administración"],
			"visualEditing.hideToolbar": ["Ocultar barra de herramientas"],
			"visualEditing.draft": ["Borrador"],
			"visualEditing.published": ["Publicado"],
			"visualEditing.unpublishedChanges": ["Cambios sin publicar"],
			"visualEditing.unsaved": ["Sin guardar"],
			"visualEditing.saving": ["Guardando…"],
			"visualEditing.saved": ["Guardado"],
			"visualEditing.saveFailed": ["Error al guardar"],
			"visualEditing.saveConflict": [
				"El contenido ha cambiado. Copia tus cambios y actualiza la página.",
			],
			"visualEditing.entryLocked": ["Otra persona está editando esta entrada."],
			"visualEditing.image": ["Imagen"],
			"visualEditing.noImageSelected": ["Ninguna imagen seleccionada"],
			"visualEditing.altText": ["Texto alternativo"],
			"visualEditing.altTextPlaceholder": ["Describe la imagen"],
			"visualEditing.replaceImage": ["Reemplazar"],
			"visualEditing.uploadImage": ["Subir"],
			"visualEditing.removeImage": ["Quitar"],
			"visualEditing.mediaLibrary": ["Biblioteca de medios"],
			"visualEditing.back": ["Volver"],
			"visualEditing.loading": ["Cargando…"],
			"visualEditing.noImagesFound": ["No se encontraron imágenes"],
			"visualEditing.mediaLoadFailed": ["No se pudieron cargar los medios"],
			"visualEditing.uploadingFile": ["Subiendo ", ["filename"], "…"],
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
			draft: "Borrador",
			published: "Publicado",
			unpublishedChanges: "Cambios sin publicar",
			unsaved: "Sin guardar",
			saving: "Guardando…",
			saved: "Guardado",
			saveFailed: "Error al guardar",
			saveConflict: "El contenido ha cambiado. Copia tus cambios y actualiza la página.",
			entryLocked: "Otra persona está editando esta entrada.",
			image: "Imagen",
			noImageSelected: "Ninguna imagen seleccionada",
			altText: "Texto alternativo",
			altTextPlaceholder: "Describe la imagen",
			replaceImage: "Reemplazar",
			uploadImage: "Subir",
			removeImage: "Quitar",
			mediaLibrary: "Biblioteca de medios",
			back: "Volver",
			loading: "Cargando…",
			noImagesFound: "No se encontraron imágenes",
			mediaLoadFailed: "No se pudieron cargar los medios",
			uploadingFile: "Subiendo {filename}…",
		});
	});

	it("keeps the file name placeholder where the translation puts it", () => {
		const labels = translateVisualEditingToolbarLabels({
			"visualEditing.uploadingFile": [["filename"], " wird hochgeladen…"],
		});

		expect(labels.uploadingFile).toBe("{filename} wird hochgeladen…");
	});
});
