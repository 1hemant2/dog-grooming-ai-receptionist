import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { createConversationOutcome } from "../../src/models/receptionist.js";
import { InMemoryConversationStore } from "../../src/models/conversation.js";
import { closeServerGracefully, createHttpServer } from "../../src/http/server.js";
import type { ConversationMessageHandler } from "../../src/services/conversation-orchestrator.js";

const conversationStore = new InMemoryConversationStore();
const endedConversationIds: string[] = [];
const orchestrator: ConversationMessageHandler = {
	async endConversation(conversation) {
		endedConversationIds.push(conversation.id);
	},

	async handleMessage(message, conversation) {
		assert.equal(conversation.businessId, "maple-street-dog-grooming");

		if (message === "Book it") {
			return {
				reply: "The Calendar change completed, but owner review is required.",
				outcome: createConversationOutcome(
					"needs_human",
					"Calendar changed but persistence failed.",
					"appointment-partial-1",
				),
			};
		}

		assert.equal(message, "What services do you offer?");

		return {
			reply: "We offer Bath.",
			outcome: createConversationOutcome("answered", "We offer Bath."),
		};
	},
};
const server = createHttpServer(conversationStore, () => orchestrator);
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

test("passes HTTP messages through the configured conversation handler", async () => {
	const response = await fetch(`${baseUrl}/conversations/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-business-id": "maple-street-dog-grooming",
		},
		body: JSON.stringify({ message: "What services do you offer?" }),
	});
	const body = await response.json();

	assert.equal(response.status, 200);
	assert.equal(body.status, "answered");
	assert.equal(body.reply, "We offer Bath.");
	assert.match(body.conversationId, /^[0-9a-f-]{36}$/);
});

test("returns the appointment ID needed to recover a partial write", async () => {
	const response = await fetch(`${baseUrl}/conversations/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-business-id": "maple-street-dog-grooming",
		},
		body: JSON.stringify({ message: "Book it" }),
	});
	const body = await response.json();

	assert.equal(response.status, 200);
	assert.equal(body.status, "needs_human");
	assert.equal(body.appointmentId, "appointment-partial-1");
});

test("ends a conversation before removing it from memory", async () => {
	const messageResponse = await fetch(`${baseUrl}/conversations/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-business-id": "maple-street-dog-grooming",
		},
		body: JSON.stringify({ message: "What services do you offer?" }),
	});
	const messageBody = await messageResponse.json();

	const endResponse = await fetch(`${baseUrl}/conversations/${messageBody.conversationId}/end`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-business-id": "maple-street-dog-grooming",
		},
		body: JSON.stringify({}),
	});
	const endBody = await endResponse.json();

	assert.equal(endResponse.status, 200);
	assert.deepEqual(endBody, {
		conversationId: messageBody.conversationId,
		status: "ended",
	});
	assert.deepEqual(endedConversationIds, [messageBody.conversationId]);

	const resumeResponse = await fetch(`${baseUrl}/conversations/messages`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			"x-business-id": "maple-street-dog-grooming",
		},
		body: JSON.stringify({
			conversationId: messageBody.conversationId,
			message: "Continue",
		}),
	});

	await resumeResponse.text();
	assert.equal(resumeResponse.status, 404);
});
