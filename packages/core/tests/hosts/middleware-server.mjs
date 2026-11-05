/** Serves a site built in middleware mode from a plain `node:http` server, as Express would. */

import { createServer } from "node:http";

const { handler } = await import(process.argv[2]);

const server = createServer((request, response) => {
	void handler(request, response, () => {
		response.statusCode = 404;
		response.end();
	});
});
server.listen(Number(process.env.PORT), process.env.HOST);
