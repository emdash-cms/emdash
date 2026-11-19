import { Hono } from "hono";
import { cors } from "hono/cors";

import { imageRoutes } from "./routes/images.js";
import { publicRoutes } from "./routes/public.js";
import { themeRoutes } from "./routes/themes.js";

const app = new Hono<{ Bindings: Env }>();

app.use(
	"/api/*",
	cors({
		origin: "*",
		allowMethods: ["GET", "HEAD", "OPTIONS"],
		allowHeaders: ["Content-Type"],
	}),
);

app.get("/health", (c) => c.json({ status: "ok" }));

app.route("/api/v1", publicRoutes);
app.route("/api/v1", themeRoutes);
app.route("/api/v1", imageRoutes);

app.all("/api/*", (c) =>
	c.json(
		{
			error:
				"The EmDash plugin marketplace is read-only. Publish plugins to the plugin registry instead: https://docs.emdashcms.com/plugins/creating-plugins/publishing/",
		},
		410,
	),
);

export default app;
