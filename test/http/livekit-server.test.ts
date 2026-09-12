import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { LiveKitConfig } from "../../src/config/constants.js";
import { closeServerGracefully, createHttpServer } from "../../src/http/server.js";
import { InMemoryConversationStore } from "../../src/models/conversation.js";
import type { LiveKitRoomCall, LiveKitVoiceHost } from "../../src/models/livekit.js";

const config: LiveKitConfig = {
	websocketUrl: "wss://demo.livekit.cloud",
	host: "https://demo.livekit.cloud",
	apiKey: "test-api-key",
	apiSecret: "test-api-secret",
	agentName: "maple-street-receptionist",
};
const startedCalls: LiveKitRoomCall[] = [];
let failSetup = false;
const voiceHost: LiveKitVoiceHost = {
	async startCall(call) {
		if (failSetup) throw new Error("Room connection failed");
		startedCalls.push(call);
	},
	async close() {},
};
const server = createHttpServer(new InMemoryConversationStore(), undefined, undefined, {
	config,
	voiceHost,
});
let baseUrl: string;
before(async () => {
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("Expected a TCP port");
	baseUrl = `http://127.0.0.1:${address.port}`;
});
after(async () => {
	await closeServerGracefully(server);
});

test("starts an in-process voice call and returns a token restricted to that room", async () => {
	const response = await createToken({ callerPhone: "+919876543210" });
	assert.equal(response.status, 200);
	const result = (await response.json()) as {
		participantToken: string;
		conversationId: string;
		roomName: string;
		participantIdentity: string;
		serverUrl: string;
	};
	assert.equal(result.serverUrl, config.websocketUrl);
	assert.deepEqual(startedCalls.at(-1), {
		businessId: "maple-street-dog-grooming",
		conversationId: result.conversationId,
		roomName: result.roomName,
		participantIdentity: result.participantIdentity,
		callerPhone: "+919876543210",
	});
	const payload = JSON.parse(
		Buffer.from(result.participantToken.split(".")[1]!, "base64url").toString(),
	);
	assert.equal(payload.sub, result.participantIdentity);
	assert.equal(payload.video.room, result.roomName);
	assert.equal(payload.video.roomJoin, true);
	assert.equal(payload.video.agent, undefined);
});

test("rejects invalid call context before starting voice", async () => {
	const count = startedCalls.length;
	assert.equal((await createToken({}, "unknown")).status, 404);
	assert.equal((await createToken({ callerPhone: "123" })).status, 400);
	assert.equal(startedCalls.length, count);
});

test("does not return a customer token when the local voice connection fails", async () => {
	failSetup = true;
	try {
		const response = await createToken();
		assert.equal(response.status, 500);
		assert.deepEqual(await response.json(), { error: "LiveKit voice setup failed" });
	} finally {
		failSetup = false;
	}
});

test("old worker transcript and end-event routes are no longer exposed", async () => {
	for (const path of ["conversations/messages", "events"]) {
		assert.equal((await fetch(`${baseUrl}/livekit/${path}`, { method: "POST" })).status, 404);
	}
});

function createToken(
	body: object = {},
	businessId = "maple-street-dog-grooming",
): Promise<Response> {
	return fetch(`${baseUrl}/livekit/token`, {
		method: "POST",
		headers: { "content-type": "application/json", "x-business-id": businessId },
		body: JSON.stringify(body),
	});
}
