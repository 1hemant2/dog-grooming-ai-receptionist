import assert from "node:assert/strict";
import { test } from "node:test";

import {
	Conversation,
	ConversationStateError,
	InvalidConversationError,
} from "../../src/models/conversation.js";
import { createConversationOutcome } from "../../src/models/receptionist.js";

const conversationDetails = {
	id: "conversation-1",
	businessId: "maple-street-dog-grooming",
	callerPhone: "+14155550100",
};

test("records conversation messages, intent, and outcome", () => {
	const conversation = new Conversation(conversationDetails);
	const outcome = createConversationOutcome(
		"needs_information",
		"Ask which service the customer wants.",
	);

	conversation.addMessage("customer", "I need an appointment.");
	conversation.recordIntent("book_appointment");
	conversation.recordOutcome(outcome);

	assert.deepEqual(conversation.messages, [
		{ author: "customer", text: "I need an appointment." },
	]);
	assert.equal(conversation.intent, "book_appointment");
	assert.equal(conversation.outcome, outcome);
});

test("allows a conversation to associate a phone number later", () => {
	const conversation = new Conversation({
		id: "conversation-without-phone",
		businessId: conversationDetails.businessId,
	});

	assert.equal(conversation.callerPhone, undefined);
	conversation.associateCallerPhone("+14155550100");

	assert.equal(conversation.callerPhone, "+14155550100");
});

test("stores a confirmed contact phone separately from caller metadata", () => {
	const conversation = new Conversation({
		id: "conversation-with-contact-phone",
		businessId: conversationDetails.businessId,
		callerPhone: "+14155550101",
	});

	conversation.confirmContactPhone("+14155550100");

	assert.equal(conversation.callerPhone, "+14155550101");
	assert.equal(conversation.contactPhone, "+14155550100");
});

test("rejects missing identity and empty messages", () => {
	assert.throws(
		() => new Conversation({ ...conversationDetails, id: " " }),
		InvalidConversationError,
	);

	const conversation = new Conversation(conversationDetails);
	assert.throws(() => conversation.addMessage("customer", " "), InvalidConversationError);
});

test("does not allow updates after a conversation ends", () => {
	const conversation = new Conversation(conversationDetails);
	conversation.end();

	assert.equal(conversation.status, "ended");
	assert.throws(() => conversation.recordIntent("services"), ConversationStateError);
	assert.throws(() => conversation.end(), ConversationStateError);
});

test("human handoff outcomes request a callback", () => {
	const outcome = createConversationOutcome(
		"needs_human",
		"A groomer must review the safety concern.",
	);

	assert.equal(outcome.callbackRequested, true);
	assert.throws(() => createConversationOutcome("answered", " "), /Outcome summary is required/);
});
