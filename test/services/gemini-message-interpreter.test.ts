import assert from "node:assert/strict";
import { test } from "node:test";

import type { GenerateContentParameters } from "@google/genai";

import { APPLICATION_CONFIG, findBusinessConfig } from "../../src/config/constants.js";
import { Conversation } from "../../src/models/conversation.js";
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
	responseText = JSON.stringify({
		intent: "book_appointment",
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
			this.parameters = parameters;
			return { text: this.responseText };
		},
	};
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

test("rejects fields that could bypass domain validation", async () => {
	const client = new FakeGeminiClient();
	client.responseText = JSON.stringify({
		intent: "book_appointment",
		contactPhone: "415-555-0100",
	});
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		client,
	);

	await assert.rejects(
		interpreter.interpret("Book an appointment.", configuredBusiness, createConversation()),
		MessageInterpreterError,
	);
});
