import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { closeServerGracefully, createHttpServer } from "../../src/http/server.js";
import { InMemoryConversationStore } from "../../src/models/conversation.js";

const server = createHttpServer(new InMemoryConversationStore());
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

test("serves the browser conversation demo", async () => {
	const response = await fetch(baseUrl);
	const page = await response.text();

	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") ?? "", /text\/html/);
	assert.match(page, /Maple Street/);
	assert.match(page, /id="message-form"/);
});

test("serves the browser demo script", async () => {
	const response = await fetch(`${baseUrl}/app.js`);
	const script = await response.text();

	assert.equal(response.status, 200);
	assert.match(response.headers.get("content-type") ?? "", /javascript/);
	assert.match(script, /\/conversations\/messages/);
});

test("returns JSON for unknown routes", async () => {
	const response = await fetch(`${baseUrl}/missing`);

	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), { error: "Not found" });
});

test("accepts a new conversation message and returns its ID", async () => {
	const response = await postConversationMessage({
		callerPhone: "+14155550100",
		message: "What time do you open?",
	});
	const body = await response.json();

	assert.equal(response.status, 202);
	assert.match(body.conversationId, /^[0-9a-f-]{36}$/);
	assert.equal(body.status, "received");
	assert.equal(
		body.reply,
		"Thanks for contacting Maple Street Dog Grooming. Your message has been received.",
	);
});

test("accepts a text message without a caller phone number", async () => {
	const response = await postConversationMessage({
		message: "What services do you offer?",
	});
	const body = await response.json();

	assert.equal(response.status, 202);
	assert.match(body.conversationId, /^[0-9a-f-]{36}$/);
});

test("resumes a conversation using its server-issued ID", async () => {
	const firstResponse = await postConversationMessage({
		callerPhone: "+14155550101",
		message: "I need an appointment.",
	});
	const firstBody = await firstResponse.json();

	const secondResponse = await postConversationMessage({
		callerPhone: "+14155550101",
		message: "A bath, please.",
		conversationId: firstBody.conversationId,
	});
	const secondBody = await secondResponse.json();

	assert.equal(secondResponse.status, 202);
	assert.equal(secondBody.conversationId, firstBody.conversationId);
});

test("starts a conversation using a voice provider's ID", async () => {
	const response = await postConversationMessage({
		callerPhone: "+14155550106",
		message: "I would like to book an appointment.",
		conversationId: "voice-call-123",
	});
	const body = await response.json();

	assert.equal(response.status, 202);
	assert.equal(body.conversationId, "voice-call-123");
});

test("rejects an unknown business", async () => {
	const response = await postConversationMessage(
		{
			callerPhone: "+14155550102",
			message: "Hello",
		},
		"unknown-business",
	);

	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), { error: "Business not found" });
});

test("requires trusted business context", async () => {
	const response = await fetch(`${baseUrl}/conversations/messages`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ callerPhone: "+14155550103", message: "Hello" }),
	});

	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), { error: "X-Business-Id header is required" });
});

test("rejects an invalid caller phone number", async () => {
	const response = await postConversationMessage({
		callerPhone: "415-555-0103",
		message: "Hello",
	});

	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), { error: "callerPhone must use E.164 format" });
});

test("does not resume a conversation for another caller", async () => {
	const firstResponse = await postConversationMessage({
		callerPhone: "+14155550104",
		message: "Hello",
	});
	const firstBody = await firstResponse.json();

	const response = await postConversationMessage({
		callerPhone: "+14155550105",
		message: "Continue",
		conversationId: firstBody.conversationId,
	});

	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), { error: "Conversation not found" });
});

interface ConversationBody {
	callerPhone?: string;
	message: string;
	conversationId?: string;
}

function postConversationMessage(
	body: ConversationBody,
	businessId = "maple-street-dog-grooming",
): Promise<Response> {
	return fetch(`${baseUrl}/conversations/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-business-id": businessId,
		},
		body: JSON.stringify(body),
	});
}
