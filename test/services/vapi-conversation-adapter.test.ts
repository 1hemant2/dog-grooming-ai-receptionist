import assert from "node:assert/strict";
import { test } from "node:test";

import { InMemoryConversationStore } from "../../src/models/conversation.js";
import { createConversationOutcome } from "../../src/models/receptionist.js";
import type { ConversationMessageHandler } from "../../src/services/conversation-orchestrator.js";
import { VapiConversationAdapter } from "../../src/services/vapi-conversation-adapter.js";

test("passes consecutive Vapi turns through the same conversation", async () => {
	const conversationStore = new InMemoryConversationStore();
	const receivedMessages: string[] = [];
	const receivedConversations: object[] = [];
	const orchestrator: ConversationMessageHandler = {
		async handleMessage(message, conversation) {
			receivedMessages.push(message);
			receivedConversations.push(conversation);
			return {
				reply: message === "Hello" ? "How can I help?" : "We offer Bath.",
				outcome: createConversationOutcome("answered", "Question answered."),
			};
		},
		async endConversation() {},
	};
	const adapter = new VapiConversationAdapter(conversationStore, () => orchestrator);
	const context = {
		businessId: "maple-street-dog-grooming",
		conversationId: "vapi-call-123",
		callerPhone: "+14155550101",
	};

	const firstResult = await adapter.handleTurn({ context, message: "Hello" });
	const secondResult = await adapter.handleTurn({
		context,
		message: "What services do you offer?",
	});

	assert.deepEqual(firstResult, {
		conversationId: "vapi-call-123",
		status: "answered",
		reply: "How can I help?",
	});
	assert.deepEqual(secondResult, {
		conversationId: "vapi-call-123",
		status: "answered",
		reply: "We offer Bath.",
	});
	assert.deepEqual(receivedMessages, ["Hello", "What services do you offer?"]);
	assert.equal(receivedConversations[0], receivedConversations[1]);
	assert.equal(receivedConversations.length, 2);
});

test("returns an appointment ID from the existing orchestrator", async () => {
	const orchestrator: ConversationMessageHandler = {
		async handleMessage() {
			return {
				reply: "The appointment is booked.",
				outcome: createConversationOutcome(
					"completed",
					"Appointment booked.",
					"appointment-123",
				),
			};
		},
		async endConversation() {},
	};
	const adapter = new VapiConversationAdapter(
		new InMemoryConversationStore(),
		() => orchestrator,
	);

	const result = await adapter.handleTurn({
		context: {
			businessId: "maple-street-dog-grooming",
			conversationId: "vapi-booking-call",
		},
		message: "Book it",
	});

	assert.deepEqual(result, {
		conversationId: "vapi-booking-call",
		status: "completed",
		reply: "The appointment is booked.",
		appointmentId: "appointment-123",
	});
});

test("fails safely when a business has no orchestrator", async () => {
	const adapter = new VapiConversationAdapter(new InMemoryConversationStore(), () => undefined);

	await assert.rejects(
		adapter.handleTurn({
			context: {
				businessId: "maple-street-dog-grooming",
				conversationId: "vapi-unconfigured-call",
			},
			message: "Hello",
		}),
		/No conversation orchestrator is configured/,
	);
});
