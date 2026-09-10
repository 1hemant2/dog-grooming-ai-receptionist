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

test("records conversation messages, intents, and outcome", () => {
	const conversation = new Conversation(conversationDetails);
	const outcome = createConversationOutcome(
		"needs_information",
		"Ask which service the customer wants.",
	);

	conversation.addMessage("customer", "I need an appointment.");
	conversation.recordIntent("pricing");
	conversation.recordIntent("book_appointment");
	conversation.recordIntent("complaint");
	conversation.recordIntent("pricing");
	conversation.recordOutcome(outcome);

	assert.deepEqual(conversation.messages, [
		{ author: "customer", text: "I need an appointment." },
	]);
	assert.deepEqual(conversation.intents, ["pricing", "book_appointment", "complaint"]);
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

test("preserves structured facts while collecting one active request", () => {
	const conversation = new Conversation(conversationDetails);
	conversation.updateActiveRequest({
		intent: "pricing",
		weightLb: 35,
	});
	conversation.recordOutcome(
		createConversationOutcome("needs_information", "Which service would you like?"),
	);
	conversation.expectCustomerField("service");

	const activeRequest = conversation.updateActiveRequest({
		intent: "unknown",
		serviceId: "full-groom",
	});

	assert.deepEqual(activeRequest, {
		intent: "pricing",
		weightLb: 35,
		serviceId: "full-groom",
	});
	assert.equal(conversation.expectedCustomerField, undefined);
});

test("resets the active request without removing conversation contact details", () => {
	const conversation = new Conversation(conversationDetails);
	conversation.confirmContactPhone("+14155550102");
	conversation.updateActiveRequest({
		intent: "book_appointment",
		petName: "Milo",
		serviceId: "bath",
	});
	conversation.recordOutcome(
		createConversationOutcome("needs_information", "What day works best?"),
	);
	conversation.expectCustomerField("requested_date");

	conversation.resetActiveRequest();

	assert.equal(conversation.activeRequest, undefined);
	assert.equal(conversation.expectedCustomerField, undefined);
	assert.equal(conversation.outcome, undefined);
	assert.equal(conversation.contactPhone, "+14155550102");
});

test("tracks whether offered appointment times were rejected", () => {
	const conversation = new Conversation(conversationDetails);
	conversation.updateActiveRequest({ intent: "book_appointment" });

	conversation.markAlternativeSlotsOffered();
	assert.equal(conversation.alternativeSlotsOffered, true);
	assert.equal(conversation.alternativeSlotsRejected, false);

	conversation.markAlternativeSlotsRejected();
	assert.equal(conversation.alternativeSlotsOffered, false);
	assert.equal(conversation.alternativeSlotsRejected, true);
});

test("does not reuse completed request facts for a new request", () => {
	const conversation = new Conversation(conversationDetails);
	conversation.updateActiveRequest({
		intent: "pricing",
		serviceId: "bath",
		weightLb: 35,
	});
	conversation.recordOutcome(createConversationOutcome("answered", "Bath starts at $45."));

	const activeRequest = conversation.updateActiveRequest({
		intent: "book_appointment",
	});

	assert.deepEqual(activeRequest, { intent: "book_appointment" });
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
