import { Toasty } from "@cloudflare/kumo";
import { i18n, type Messages } from "@lingui/core";
import { I18nProvider } from "@lingui/react";
import React from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { LocaleDirectionProvider } from "./LocaleDirectionProvider.js";

import "./styles.css";

const catalogs = import.meta.glob<{ messages: Messages }>("./locales/en/messages.mjs", {
	eager: true,
});
const messages = catalogs["./locales/en/messages.mjs"]?.messages;
if (!messages) throw new Error("Compiled English catalog is missing");
i18n.loadAndActivate({ locale: "en", messages });

const root = document.getElementById("root");
if (!root) throw new Error("Admin application root is missing");

createRoot(root).render(
	<React.StrictMode>
		<I18nProvider i18n={i18n}>
			<LocaleDirectionProvider locale="en">
				<Toasty>
					<App />
				</Toasty>
			</LocaleDirectionProvider>
		</I18nProvider>
	</React.StrictMode>,
);
