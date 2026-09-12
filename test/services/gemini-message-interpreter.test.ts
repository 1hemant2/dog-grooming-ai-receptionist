import assert from "node:assert/strict";
import { test } from "node:test";

import type { GenerateContentParameters } from "@google/genai";

import { APPLICATION_CONFIG, findBusinessConfig } from "../../src/config/constants.js";
import { Conversation } from "../../src/models/conversation.js";
import {
	createConversationOutcome,
	type ExpectedCustomerField,
} from "../../src/models/receptionist.js";
import {
	GeminiMessageInterpreter,
	type GeminiContentClient,
} from "../../src/services/gemini-message-interpreter.js";
import { MessageInterpreterError } from "../../src/services/receptionist-dependencies.js";

const business = findBusinessConfig("maple-street-dog-grooming");

if (!business) {
	throw new Error("Expected Maple Street business configuration in test setup");
}

const configuredBusiness = business;

class FakeGeminiClient implements GeminiContentClient {
	parameters: GenerateContentParameters | undefined;
	callCount = 0;
	responseText = JSON.stringify({
		intent: "book_appointment",
		conversationAction: "continue",
		customerName: "Alex Morgan",
		contactPhone: "+14155550100",
		contactPhoneConfirmed: true,
		petName: "Milo",
		weightLb: 25,
		rabiesVaccinationStatus: "current",
		serviceId: "bath",
		requestedDate: "2026-09-12",
		requestedTime: "10:00",
		confirmation: true,
	});

	models = {
		generateContent: async (
			parameters: GenerateContentParameters,
		): Promise<{ text: string | undefined }> => {
			this.callCount += 1;
			this.parameters = parameters;
			return { text: this.responseText };
		},
	};
}

function createConversationAwaiting(expectedCustomerField: ExpectedCustomerField): Conversation {
	const conversation = createConversation();
	conversation.updateActiveRequest({ intent: "book_appointment" });
	conversation.recordOutcome(
		createConversationOutcome("needs_information", "More information is required."),
	);
	conversation.expectCustomerField(expectedCustomerField);
	return conversation;
}

function createConversation(): Conversation {
	const conversation = new Conversation({
		id: "conversation-interpreter-1",
		businessId: configuredBusiness.id,
	});
	conversation.addMessage("customer", "I want to book a bath for Milo on Saturday at 10.");
	return conversation;
}

test("converts Gemini JSON into validated receptionist fields", async () => {
	const client = new FakeGeminiClient();
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		client,
	);

	const result = await interpreter.interpret(
		"I want to book a bath for Milo on Saturday at 10.",
		configuredBusiness,
		createConversation(),
	);

	assert.equal(result.intent, "book_appointment");
	assert.equal(result.serviceId, "bath");
	assert.equal(result.contactPhone, "+14155550100");
	assert.equal(result.confirmation, true);
	assert.equal(client.parameters?.model, "test-model");
	assert.equal(
		client.parameters?.config?.httpOptions?.timeout,
		APPLICATION_CONFIG.externalRequestTimeoutMs,
	);
	assert.equal(client.parameters?.config?.responseMimeType, "application/json");
	assert.match(String(client.parameters?.contents), /Maple Street Dog Grooming/);
	assert.match(String(client.parameters?.contents), /Extract facts stated/);
	assert.match(String(client.parameters?.contents), /clearly starts a new request/);
	assert.match(String(client.parameters?.contents), /Current local date:/);
	assert.equal(
		client.parameters?.config?.maxOutputTokens,
		APPLICATION_CONFIG.interpreterMaxOutputTokens,
	);
	assert.doesNotMatch(
		JSON.stringify(client.parameters?.config?.responseJsonSchema),
		/requestedStartAt|requestedEndAt/,
	);
});

test("summarizes the final business outcome instead of the last question", async () => {
	const client = new FakeGeminiClient();
	client.responseText = "Milo's Bath appointment was booked successfully.";
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		client,
	);
	const conversation = createConversation();
	conversation.addMessage("receptionist", "What name should I put on the appointment?");
	const outcome = createConversationOutcome(
		"completed",
		"What name should I put on the appointment?",
		"appointment-123",
	);

	const summary = await interpreter.summarize(configuredBusiness, conversation, outcome);

	assert.equal(summary, "Milo's Bath appointment was booked successfully.");
	assert.equal(client.parameters?.model, "test-model");
	assert.equal(
		client.parameters?.config?.maxOutputTokens,
		APPLICATION_CONFIG.outcomeSummaryMaxOutputTokens,
	);
	assert.match(String(client.parameters?.contents), /final business result/i);
	assert.match(String(client.parameters?.contents), /Final outcome status: completed/);
});

test("rejects malformed JSON from Gemini", async () => {
	const client = new FakeGeminiClient();
	client.responseText = "not-json";
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		client,
	);

	await assert.rejects(
		interpreter.interpret(
			"What services do you offer?",
			configuredBusiness,
			createConversation(),
		),
		MessageInterpreterError,
	);
});

test("normalizes a formatted US contact phone before domain validation", async () => {
	const client = new FakeGeminiClient();
	client.responseText = JSON.stringify({
		intent: "book_appointment",
		contactPhone: "415-555-0100",
	});
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		client,
	);

	const result = await interpreter.interpret(
		"Use 415-555-0100.",
		configuredBusiness,
		createConversation(),
	);

	assert.equal(result.contactPhone, "+14155550100");
});

test("ignores a contact phone that cannot be normalized safely", async () => {
	const client = new FakeGeminiClient();
	client.responseText = JSON.stringify({
		intent: "book_appointment",
		contactPhone: "555",
	});
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		client,
	);

	const result = await interpreter.interpret(
		"Use 555.",
		configuredBusiness,
		createConversation(),
	);

	assert.equal(result.contactPhone, undefined);
});

test("reads an expected phone number locally without calling Gemini", async () => {
	const client = new FakeGeminiClient();
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		client,
	);

	const result = await interpreter.interpret(
		"415-555-0100",
		configuredBusiness,
		createConversationAwaiting("contact_phone"),
	);

	assert.equal(result.contactPhone, "+14155550100");
	assert.equal(client.callCount, 0);
});

test("reads an expected customer name locally without calling Gemini", async () => {
	const client = new FakeGeminiClient();
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		client,
	);

	const result = await interpreter.interpret(
		"My name is Hemant Kumar",
		configuredBusiness,
		createConversationAwaiting("customer_name"),
	);

	assert.equal(result.customerName, "Hemant Kumar");
	assert.equal(client.callCount, 0);
});

test("resolves an expected natural date to the next occurrence locally", async () => {
	const client = new FakeGeminiClient();
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		client,
		() => new Date("2026-09-10T12:00:00.000Z"),
	);

	const result = await interpreter.interpret(
		"11th September",
		configuredBusiness,
		createConversationAwaiting("requested_date"),
	);

	assert.equal(result.requestedDate, "2026-09-11");
	assert.equal(client.callCount, 0);
});

test("reads a full alternate appointment date and time locally", async () => {
	const client = new FakeGeminiClient();
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		client,
		() => new Date("2026-09-10T12:00:00.000Z"),
	);

	const result = await interpreter.interpret(
		"Saturday, September 12 at 2 PM works.",
		configuredBusiness,
		createConversationAwaiting("requested_time"),
	);

	assert.equal(result.requestedDate, "2026-09-12");
	assert.equal(result.requestedTime, "14:00");
	assert.equal(client.callCount, 0);
});

test("uses Gemini to classify a response after appointment alternatives were offered", async () => {
	const client = new FakeGeminiClient();
	client.responseText = JSON.stringify({
		intent: "book_appointment",
		conversationAction: "reject_suggested_times",
	});
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		client,
	);
	const conversation = createConversationAwaiting("requested_time");
	conversation.markAlternativeSlotsOffered();

	const result = await interpreter.interpret("none", configuredBusiness, conversation);

	assert.equal(result.conversationAction, "reject_suggested_times");
	assert.equal(client.callCount, 1);
	assert.match(String(client.parameters?.contents), /alternatives were just offered: true/i);
});

test("uses Gemini when the customer proposes an exact time after rejecting alternatives", async () => {
	const client = new FakeGeminiClient();
	client.responseText = JSON.stringify({
		intent: "book_appointment",
		conversationAction: "require_exact_time",
		requestedDate: "2026-09-11",
		requestedTime: "15:00",
	});
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		client,
		() => new Date("2026-09-10T12:00:00.000Z"),
	);
	const conversation = createConversationAwaiting("requested_date");
	conversation.markAlternativeSlotsRejected();

	const result = await interpreter.interpret(
		"only 3pm tommrow will work for me",
		configuredBusiness,
		conversation,
	);

	assert.equal(result.conversationAction, "require_exact_time");
	assert.equal(result.requestedDate, "2026-09-11");
	assert.equal(result.requestedTime, "15:00");
	assert.equal(client.callCount, 1);
	assert.match(String(client.parameters?.contents), /recently rejected.*true/i);
});

test("reads a misspelled relative date and time locally", async () => {
	const client = new FakeGeminiClient();
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		client,
		() => new Date("2026-09-10T12:00:00.000Z"),
	);

	const result = await interpreter.interpret(
		"tommorow 3pm will only work for me",
		configuredBusiness,
		createConversationAwaiting("requested_date"),
	);

	assert.equal(result.requestedDate, "2026-09-11");
	assert.equal(result.requestedTime, "15:00");
	assert.equal(client.callCount, 0);
});

test("reads the common tommrow spelling locally", async () => {
	const client = new FakeGeminiClient();
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		client,
		() => new Date("2026-09-10T12:00:00.000Z"),
	);

	const result = await interpreter.interpret(
		"only 3pm tommrow will work for me",
		configuredBusiness,
		createConversationAwaiting("requested_date"),
	);

	assert.equal(result.requestedDate, "2026-09-11");
	assert.equal(result.requestedTime, "15:00");
	assert.equal(client.callCount, 0);
});

test("recognizes a configured service details question locally", async () => {
	const client = new FakeGeminiClient();
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		client,
	);

	const result = await interpreter.interpret(
		"Can you explain what Full Groom includes?",
		configuredBusiness,
		createConversation(),
	);

	assert.equal(result.intent, "services");
	assert.equal(result.serviceId, "full-groom");
	assert.equal(client.callCount, 0);
});

test("keeps the booking intent for an acknowledgement without a date", async () => {
	const client = new FakeGeminiClient();
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		client,
	);
	const conversation = createConversationAwaiting("requested_date");

	const result = await interpreter.interpret("Do it for Tommy", configuredBusiness, conversation);

	assert.equal(result.intent, "book_appointment");
	assert.equal(result.requestedDate, undefined);
	assert.equal(client.callCount, 0);
});

test("ignores invalid optional Gemini fields instead of rejecting the message", async () => {
	const client = new FakeGeminiClient();
	client.responseText = JSON.stringify({
		intent: "book_appointment",
		requestedTime: "morning",
		resolution: 42,
		unexpectedModelField: "ignored",
	});
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		client,
	);

	const result = await interpreter.interpret(
		"Sometime that day",
		configuredBusiness,
		createConversation(),
	);

	assert.equal(result.intent, "book_appointment");
	assert.equal(result.requestedTime, undefined);
	assert.equal(result.resolution, undefined);
});

test("sends only the configured recent history window to Gemini", async () => {
	const client = new FakeGeminiClient();
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		client,
	);
	const conversation = createConversation();

	for (let index = 1; index <= 8; index += 1) {
		conversation.addMessage(index % 2 === 0 ? "customer" : "receptionist", `turn-${index}`);
	}

	await interpreter.interpret("A new pricing question", configuredBusiness, conversation);

	const prompt = String(client.parameters?.contents);
	assert.doesNotMatch(prompt, /turn-1/);
	assert.match(prompt, /turn-8/);
});
