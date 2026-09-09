import assert from "node:assert/strict";
import { test } from "node:test";

import {
	ConversationNotFoundError,
	InMemoryConversationStore,
} from "../../src/models/conversation.js";

const firstMessage = {
	businessId: "maple-street-dog-grooming",
	callerPhone: "+14155550100",
	message: "What time do you open?",
	conversationId: undefined,
};

test("creates and resumes a conversation", () => {
	const store = new InMemoryConversationStore();
	const conversationId = store.receiveMessage(firstMessage);

	const resumedConversationId = store.receiveMessage({
		...firstMessage,
		message: "Are you open Sunday?",
		conversationId,
	});

	assert.match(conversationId, /^[0-9a-f-]{36}$/);
	assert.equal(resumedConversationId, conversationId);
});

test("starts a conversation with a caller-supplied ID", () => {
	const store = new InMemoryConversationStore();
	const suppliedConversationId = "voice-call-123";

	const conversationId = store.receiveMessage({
		...firstMessage,
		conversationId: suppliedConversationId,
	});

	const resumedConversationId = store.receiveMessage({
		...firstMessage,
		message: "I would like to book a bath.",
		conversationId: suppliedConversationId,
	});

	assert.equal(conversationId, suppliedConversationId);
	assert.equal(resumedConversationId, suppliedConversationId);
});

test("allows a text conversation to start without a phone number", () => {
	const store = new InMemoryConversationStore();
	const conversationId = store.receiveMessage({
		businessId: firstMessage.businessId,
		message: firstMessage.message,
		conversationId: undefined,
	});

	const resumedConversationId = store.receiveMessage({
		businessId: firstMessage.businessId,
		message: "I would like to know your prices.",
		conversationId,
	});

	assert.equal(resumedConversationId, conversationId);
});

test("associates a phone number when it is provided later", () => {
	const store = new InMemoryConversationStore();
	const conversationId = store.receiveMessage({
		businessId: firstMessage.businessId,
		message: firstMessage.message,
		conversationId: undefined,
	});

	store.receiveMessage({
		businessId: firstMessage.businessId,
		callerPhone: firstMessage.callerPhone,
		message: "I want to book an appointment.",
		conversationId,
	});

	assert.throws(
		() =>
			store.receiveMessage({
				businessId: firstMessage.businessId,
				message: "Continue without a phone number",
				conversationId,
			}),
		ConversationNotFoundError,
	);

	assert.throws(
		() =>
			store.receiveMessage({
				businessId: firstMessage.businessId,
				callerPhone: "+14155550101",
				message: "Continue",
				conversationId,
			}),
		ConversationNotFoundError,
	);
});

test("loads a conversation so orchestration can confirm contact details", () => {
	const store = new InMemoryConversationStore();
	const conversationId = store.receiveMessage({
		businessId: firstMessage.businessId,
		message: firstMessage.message,
		conversationId: undefined,
	});

	const conversation = store.getConversation({
		businessId: firstMessage.businessId,
		conversationId,
	});
	conversation.confirmContactPhone(firstMessage.callerPhone);

	assert.equal(conversation.contactPhone, firstMessage.callerPhone);
});

test("does not resume a conversation for another business or caller", () => {
	const store = new InMemoryConversationStore();
	const conversationId = store.receiveMessage(firstMessage);

	assert.throws(
		() =>
			store.receiveMessage({
				...firstMessage,
				businessId: "another-business",
				conversationId,
			}),
		ConversationNotFoundError,
	);

	assert.throws(
		() =>
			store.receiveMessage({
				...firstMessage,
				callerPhone: "+14155550101",
				conversationId,
			}),
		ConversationNotFoundError,
	);
});

test("deletes conversation state when a call ends", () => {
	const store = new InMemoryConversationStore();
	const conversationId = store.receiveMessage(firstMessage);

	store.endConversation({
		businessId: firstMessage.businessId,
		callerPhone: firstMessage.callerPhone,
		conversationId,
	});

	assert.throws(
		() =>
			store.endConversation({
				businessId: firstMessage.businessId,
				callerPhone: firstMessage.callerPhone,
				conversationId,
			}),
		ConversationNotFoundError,
	);
});

test("does not delete another business's conversation", () => {
	const store = new InMemoryConversationStore();
	const conversationId = store.receiveMessage(firstMessage);

	assert.throws(
		() =>
			store.endConversation({
				businessId: "another-business",
				callerPhone: firstMessage.callerPhone,
				conversationId,
			}),
		ConversationNotFoundError,
	);

	const resumedConversationId = store.receiveMessage({
		...firstMessage,
		conversationId,
	});
	assert.equal(resumedConversationId, conversationId);
});
