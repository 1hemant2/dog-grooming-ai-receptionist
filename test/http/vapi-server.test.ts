import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import type { VapiConfig } from "../../src/config/constants.js";
import { closeServerGracefully, createHttpServer } from "../../src/http/server.js";
import { InMemoryConversationStore } from "../../src/models/conversation.js";
import type { VapiCallHandler, VapiConversationTurn } from "../../src/models/vapi.js";

const config: VapiConfig = {
	serverToken: "test-vapi-token",
	businessPhoneMappings: [
		{
			businessId: "maple-street-dog-grooming",
			phoneNumber: "+14155550100",
		},
	],
};
const receivedTurns: VapiConversationTurn[] = [];
const receivedEndCalls: VapiConversationTurn["context"][] = [];
const handler: VapiCallHandler = {
	async handleTurn(turn) {
		if (turn.message === "Trigger provider failure") {
			throw new Error("Sensitive provider details");
		}

		receivedTurns.push(turn);
		return {
			conversationId: turn.context.conversationId,
			status: "answered",
			reply: "We offer Bath.",
		};
	},
	async endCall(context) {
		receivedEndCalls.push(context);
	},
};
const server = createHttpServer(new InMemoryConversationStore(), undefined, {
	config,
	turnHandler: handler,
});
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

test("converts authenticated Vapi identity into trusted conversation context", async () => {
	const response = await sendVapiRequest();

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		conversationId: "vapi-call-123",
		status: "answered",
		reply: "We offer Bath.",
	});
	assert.deepEqual(receivedTurns.at(-1), {
		context: {
			businessId: "maple-street-dog-grooming",
			conversationId: "vapi-call-123",
			callerPhone: "+14155550101",
		},
		message: "What services do you offer?",
	});
});

test("rejects a request without Vapi authentication", async () => {
	const handledBeforeRequest = receivedTurns.length;
	const response = await sendVapiRequest({}, "");

	assert.equal(response.status, 401);
	assert.deepEqual(await response.json(), { error: "Unauthorized" });
	assert.equal(receivedTurns.length, handledBeforeRequest);
});

test("rejects an unknown called phone number", async () => {
	const handledBeforeRequest = receivedTurns.length;
	const response = await sendVapiRequest({ calledPhoneNumber: "+14155550999" });

	assert.equal(response.status, 404);
	assert.deepEqual(await response.json(), {
		error: "Business not found for the called phone number",
	});
	assert.equal(receivedTurns.length, handledBeforeRequest);
});

test("rejects a malformed Vapi call ID", async () => {
	const handledBeforeRequest = receivedTurns.length;
	const response = await sendVapiRequest({ callId: "invalid call id" });

	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), { error: "callId is invalid" });
	assert.equal(receivedTurns.length, handledBeforeRequest);
});

test("rejects a missing Vapi call ID", async () => {
	const handledBeforeRequest = receivedTurns.length;
	const response = await sendVapiRequest({ callId: "" });

	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), { error: "callId is required" });
	assert.equal(receivedTurns.length, handledBeforeRequest);
});

test("rejects an invalid caller number", async () => {
	const handledBeforeRequest = receivedTurns.length;
	const response = await sendVapiRequest({ callerPhone: "415-555-0101" });

	assert.equal(response.status, 400);
	assert.deepEqual(await response.json(), {
		error: "callerPhone must use E.164 format",
	});
	assert.equal(receivedTurns.length, handledBeforeRequest);
});

test("allows a browser Vapi call without a resolved caller number", async () => {
	const response = await sendVapiRequest({ callerPhone: "{{customer.number}}" });

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		conversationId: "vapi-call-123",
		status: "answered",
		reply: "We offer Bath.",
	});
	assert.equal(receivedTurns.at(-1)?.context.callerPhone, undefined);
});

test("does not expose provider errors in the Vapi response", async () => {
	const response = await sendVapiRequest({ message: "Trigger provider failure" });

	assert.equal(response.status, 500);
	assert.deepEqual(await response.json(), { error: "Internal server error" });
});

test("finalizes a Vapi call from an end-of-call event", async () => {
	const response = await sendVapiEvent();

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), {
		conversationId: "vapi-call-123",
		status: "ended",
	});
	assert.deepEqual(receivedEndCalls.at(-1), {
		businessId: "maple-street-dog-grooming",
		conversationId: "vapi-call-123",
		callerPhone: "+14155550101",
	});
});

test("ignores Vapi events that do not end a call", async () => {
	const handledBeforeRequest = receivedEndCalls.length;
	const response = await sendVapiEvent("status-update");

	assert.equal(response.status, 200);
	assert.deepEqual(await response.json(), { status: "ignored" });
	assert.equal(receivedEndCalls.length, handledBeforeRequest);
});

interface VapiRequestOverrides {
	callId?: string;
	calledPhoneNumber?: string;
	callerPhone?: string;
	message?: string;
	requestId?: string;
}

function sendVapiRequest(
	overrides: VapiRequestOverrides = {},
	token = config.serverToken,
): Promise<Response> {
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (token) {
		headers.authorization = `Bearer ${token}`;
	}

	return fetch(`${baseUrl}/vapi/conversations/messages`, {
		method: "POST",
		headers,
		body: JSON.stringify({
			callId: "vapi-call-123",
			calledPhoneNumber: "+14155550100",
			callerPhone: "+14155550101",
			message: "What services do you offer?",
			...overrides,
		}),
	});
}

function sendVapiEvent(type = "end-of-call-report", token = config.serverToken): Promise<Response> {
	return fetch(`${baseUrl}/vapi/events`, {
		method: "POST",
		headers: {
			"content-type": "application/json",
			authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({
			message: {
				type,
				call: {
					id: "vapi-call-123",
					phoneNumber: { number: "+14155550100" },
					customer: { number: "+14155550101" },
				},
			},
		}),
	});
}
