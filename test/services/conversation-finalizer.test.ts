import assert from "node:assert/strict";
import { test } from "node:test";

import {
	ConversationNotFoundError,
	InMemoryConversationStore,
} from "../../src/models/conversation.js";
import {
	ConversationFinalizer,
	type ConversationOrchestratorResolver,
} from "../../src/services/conversation-finalizer.js";
import type { ConversationMessageHandler } from "../../src/services/conversation-orchestrator.js";

const businessId = "maple-street-dog-grooming";

function createHandler(endedConversationIds: string[]): ConversationMessageHandler {
	return {
		async handleMessage() {
			throw new Error("Not used in this test");
		},
		async endConversation(conversation) {
			endedConversationIds.push(conversation.id);
		},
	};
}

test("finalizes an inactive conversation and removes it from memory", async () => {
	let now = new Date("2026-09-10T12:00:00.000Z");
	const store = new InMemoryConversationStore(() => now);
	const conversationId = store.receiveMessage({
		businessId,
		message: "What services do you offer?",
		conversationId: undefined,
	});
	const endedConversationIds: string[] = [];
	const handler = createHandler(endedConversationIds);
	const resolveOrchestrator: ConversationOrchestratorResolver = () => handler;
	const finalizer = new ConversationFinalizer(
		store,
		resolveOrchestrator,
		15 * 60 * 1_000,
		() => now,
	);

	now = new Date("2026-09-10T12:15:00.000Z");
	const finalizedCount = await finalizer.finalizeInactiveConversations();

	assert.equal(finalizedCount, 1);
	assert.deepEqual(endedConversationIds, [conversationId]);
	assert.throws(
		() => store.getConversation({ businessId, conversationId }),
		ConversationNotFoundError,
	);
});

test("keeps an inactive conversation when Call Log finalization fails", async () => {
	let now = new Date("2026-09-10T12:00:00.000Z");
	const store = new InMemoryConversationStore(() => now);
	const conversationId = store.receiveMessage({
		businessId,
		message: "What services do you offer?",
		conversationId: undefined,
	});
	const failingHandler: ConversationMessageHandler = {
		async handleMessage() {
			throw new Error("Not used in this test");
		},
		async endConversation() {
			throw new Error("Call Log unavailable");
		},
	};
	const finalizer = new ConversationFinalizer(
		store,
		() => failingHandler,
		15 * 60 * 1_000,
		() => now,
	);

	now = new Date("2026-09-10T12:15:00.000Z");
	const finalizedCount = await finalizer.finalizeInactiveConversations();

	assert.equal(finalizedCount, 0);
	assert.equal(store.getConversation({ businessId, conversationId }).id, conversationId);
});
