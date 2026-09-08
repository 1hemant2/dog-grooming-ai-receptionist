import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { closeServerGracefully, createHttpServer } from "../../src/http/server.js";

const server = createHttpServer();
let baseUrl: string;

before(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));

	const address = server.address();
	if (!address || typeof address === "string") {
		throw new Error("Expected the test server to use a TCP port");
	}

	baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
	await closeServerGracefully(server);
});

test("reports that the service is healthy", async () => {
	const response = await fetch(`${baseUrl}/health`);

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		status: "ok",
		service: "receptionist",
	});
});

test("returns JSON for unknown routes", async () => {
	const response = await fetch(`${baseUrl}/missing`);

	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), { error: "Not found" });
});
