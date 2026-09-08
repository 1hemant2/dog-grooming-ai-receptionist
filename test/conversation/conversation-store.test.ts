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
