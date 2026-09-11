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

test("returns an end-call signal and finalizes after an explicit goodbye", async () => {
	let endConversationCount = 0;
	const conversationStore = new InMemoryConversationStore();
	const orchestrator: ConversationMessageHandler = {
		async handleMessage() {
			return {
				reply: "Thanks for calling Maple Street Dog Grooming. Goodbye!",
				outcome: createConversationOutcome(
					"needs_information",
					"The customer ended the conversation before the request was completed.",
				),
			};
		},
		async endConversation() {
			endConversationCount += 1;
		},
	};
	const adapter = new VapiConversationAdapter(conversationStore, () => orchestrator);
	const context = {
		businessId: "maple-street-dog-grooming",
		conversationId: "vapi-explicit-goodbye",
	};

	const result = await adapter.handleTurn({
		context,
		message: "I don't want to continue",
	});

	assert.deepEqual(result, {
		conversationId: context.conversationId,
		status: "needs_information",
		reply: "Thanks for calling Maple Street Dog Grooming. Goodbye!",
		endCall: true,
	});
	assert.equal(endConversationCount, 1);
	assert.throws(() =>
		conversationStore.getConversation({
			businessId: context.businessId,
			conversationId: context.conversationId,
		}),
	);
	await adapter.endCall(context);
});

test("does not signal an end call for a normal customer message", async () => {
	const conversationStore = new InMemoryConversationStore();
	const orchestrator: ConversationMessageHandler = {
		async handleMessage() {
			return {
				reply: "No problem. What other date or time would work for you?",
				outcome: createConversationOutcome(
					"needs_information",
					"The customer needs another appointment time.",
				),
			};
		},
		async endConversation() {},
	};
	const adapter = new VapiConversationAdapter(conversationStore, () => orchestrator);
	const context = {
		businessId: "maple-street-dog-grooming",
		conversationId: "vapi-continue-call",
	};

	const result = await adapter.handleTurn({ context, message: "None of those work" });

	assert.equal(result.endCall, undefined);
	assert.doesNotThrow(() =>
		conversationStore.getConversation({
			businessId: context.businessId,
			conversationId: context.conversationId,
		}),
	);
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

test("reuses the result for a duplicate request ID", async () => {
	const conversationStore = new InMemoryConversationStore();
	let handledMessageCount = 0;
	const orchestrator: ConversationMessageHandler = {
		async handleMessage() {
			handledMessageCount += 1;
			return {
				reply: "How can I help?",
				outcome: createConversationOutcome("answered", "Question answered."),
			};
		},
		async endConversation() {},
	};
	const adapter = new VapiConversationAdapter(conversationStore, () => orchestrator);
	const turn = {
		context: {
			businessId: "maple-street-dog-grooming",
			conversationId: "vapi-duplicate-call",
		},
		message: "Hello",
		requestId: "request-123",
	};

	const firstResult = adapter.handleTurn(turn);
	const duplicateResult = adapter.handleTurn(turn);

	assert.equal(firstResult, duplicateResult);
	assert.deepEqual(await duplicateResult, {
		conversationId: "vapi-duplicate-call",
		status: "answered",
		reply: "How can I help?",
	});
	assert.equal(handledMessageCount, 1);
	assert.equal(
		conversationStore.getConversation({
			businessId: "maple-street-dog-grooming",
			conversationId: "vapi-duplicate-call",
		}).messages.length,
		1,
	);
});

test("processes overlapping turns in order", async () => {
	const firstTurnStarted = createDeferred<void>();
	const releaseFirstTurn = createDeferred<void>();
	const receivedMessages: string[] = [];
	let activeMessageCount = 0;
	let maximumActiveMessageCount = 0;
	const orchestrator: ConversationMessageHandler = {
		async handleMessage(message) {
			receivedMessages.push(message);
			activeMessageCount += 1;
			maximumActiveMessageCount = Math.max(maximumActiveMessageCount, activeMessageCount);

			if (message === "First message") {
				firstTurnStarted.resolve();
				await releaseFirstTurn.promise;
			}

			activeMessageCount -= 1;
			return {
				reply: "Received.",
				outcome: createConversationOutcome("answered", "Question answered."),
			};
		},
		async endConversation() {},
	};
	const adapter = new VapiConversationAdapter(
		new InMemoryConversationStore(),
		() => orchestrator,
	);
	const context = {
		businessId: "maple-street-dog-grooming",
		conversationId: "vapi-ordered-call",
	};

	const firstTurn = adapter.handleTurn({ context, message: "First message" });
	await firstTurnStarted.promise;
	const secondTurn = adapter.handleTurn({ context, message: "Second message" });

	assert.deepEqual(receivedMessages, ["First message"]);
	assert.equal(maximumActiveMessageCount, 1);

	releaseFirstTurn.resolve();
	await Promise.all([firstTurn, secondTurn]);

	assert.deepEqual(receivedMessages, ["First message", "Second message"]);
	assert.equal(maximumActiveMessageCount, 1);
});

test("waits for the active turn and finalizes only once", async () => {
	const turnStarted = createDeferred<void>();
	const releaseTurn = createDeferred<void>();
	let endConversationCount = 0;
	const orchestrator: ConversationMessageHandler = {
		async handleMessage() {
			turnStarted.resolve();
			await releaseTurn.promise;
			return {
				reply: "Received.",
				outcome: createConversationOutcome("answered", "Question answered."),
			};
		},
		async endConversation() {
			endConversationCount += 1;
		},
	};
	const conversationStore = new InMemoryConversationStore();
	const adapter = new VapiConversationAdapter(conversationStore, () => orchestrator);
	const context = {
		businessId: "maple-street-dog-grooming",
		conversationId: "vapi-end-call",
		callerPhone: "+14155550101",
	};

	const turn = adapter.handleTurn({ context, message: "Hello" });
	await turnStarted.promise;
	const firstEnd = adapter.endCall(context);
	const duplicateEnd = adapter.endCall(context);

	assert.equal(firstEnd, duplicateEnd);
	assert.equal(endConversationCount, 0);

	releaseTurn.resolve();
	await Promise.all([turn, firstEnd]);
	await adapter.endCall(context);

	assert.equal(endConversationCount, 1);
	assert.throws(() =>
		conversationStore.getConversation({
			businessId: context.businessId,
			conversationId: context.conversationId,
			callerPhone: context.callerPhone,
		}),
	);
});

test("preserves conversation state when finalization fails", async () => {
	let endConversationCount = 0;
	let shouldFail = true;
	const orchestrator: ConversationMessageHandler = {
		async handleMessage() {
			return {
				reply: "Received.",
				outcome: createConversationOutcome("answered", "Question answered."),
			};
		},
		async endConversation() {
			endConversationCount += 1;
			if (shouldFail) {
				shouldFail = false;
				throw new Error("Call Log is unavailable");
			}
		},
	};
	const conversationStore = new InMemoryConversationStore();
	const adapter = new VapiConversationAdapter(conversationStore, () => orchestrator);
	const context = {
		businessId: "maple-street-dog-grooming",
		conversationId: "vapi-retry-end-call",
	};

	await adapter.handleTurn({ context, message: "Hello" });
	await assert.rejects(adapter.endCall(context), /Call Log is unavailable/);
	assert.doesNotThrow(() =>
		conversationStore.getConversation({
			businessId: context.businessId,
			conversationId: context.conversationId,
		}),
	);

	await adapter.endCall(context);

	assert.equal(endConversationCount, 2);
	assert.throws(() =>
		conversationStore.getConversation({
			businessId: context.businessId,
			conversationId: context.conversationId,
		}),
	);
});

function createDeferred<T>(): {
	promise: Promise<T>;
	resolve(value: T): void;
} {
	let resolvePromise: (value: T) => void = () => undefined;
	const promise = new Promise<T>((resolve) => {
		resolvePromise = resolve;
	});

	return { promise, resolve: resolvePromise };
}
