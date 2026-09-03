import { I18nProvider } from "@lingui/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App.js";
import { i18n } from "./i18n.js";

import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Application root is missing");

createRoot(root).render(
	<StrictMode>
		<I18nProvider i18n={i18n}>
			<App />
		</I18nProvider>
	</StrictMode>,
);
