import * as React from "react";
import { createRoot } from "react-dom/client";

import { ConsoleApp } from "./App.js";

import "./styles.css";

const container = document.getElementById("console-root");
if (!container) throw new Error("#console-root element not found");

createRoot(container).render(
	<React.StrictMode>
		<ConsoleApp />
	</React.StrictMode>,
);
