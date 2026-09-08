import assert from "node:assert/strict";
import { test } from "node:test";

import { closeServerGracefully, createHttpServer } from "../../src/http/server.js";

test("graceful shutdown stops the HTTP server", async () => {
	const server = createHttpServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

	await closeServerGracefully(server);

	assert.equal(server.listening, false);
});

test("graceful shutdown is safe before the server starts", async () => {
	const server = createHttpServer();

	await closeServerGracefully(server);

	assert.equal(server.listening, false);
});
