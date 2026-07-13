import * as React from "react";
import { createRoot } from "react-dom/client";

import { ConsoleApp } from "./App.js";
import { DEFAULT_LOCALE, loadMessages } from "./locales/index.js";

import "./styles.css";

const container = document.getElementById("console-root");
if (!container) throw new Error("#console-root element not found");

async function bootstrap(root: HTMLElement) {
	const messages = await loadMessages(DEFAULT_LOCALE);
	createRoot(root).render(
		<React.StrictMode>
			<ConsoleApp locale={DEFAULT_LOCALE} messages={messages} />
		</React.StrictMode>,
	);
}

void bootstrap(container);
