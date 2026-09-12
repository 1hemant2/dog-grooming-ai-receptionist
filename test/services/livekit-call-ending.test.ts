import assert from "node:assert/strict";
import { test } from "node:test";

import { playVoiceReply } from "../../src/livekit/voice-reply.js";
import { LiveKitVoiceRuntime } from "../../src/livekit/voice-runtime.js";
import type { VoiceTurnResult } from "../../src/models/voice-call.js";
import { InMemoryConversationStore } from "../../src/models/conversation.js";
import { createConversationOutcome } from "../../src/models/receptionist.js";
import { isConversationEndRequest } from "../../src/services/customer-message-parser.js";
import { LiveKitConversationAdapter } from "../../src/services/livekit-conversation-adapter.js";

test("recognizes explicit and polite end-call requests without treating a rejection as goodbye", () => {
	for (const message of [
		"I don't want to continue",
		"I dont want to continue this call",
		"Please end the call",
		"Could you hang up please?",
		"Goodbye, thank you",
		"End this conversation now",
	]) {
		assert.equal(isConversationEndRequest(message), true, message);
	}
	for (const message of [
		"No",
		"No, that time doesn't work",
		"Start over",
		"Please cancel my appointment",
		"Don't end the call",
		"I want to continue",
	]) {
		assert.equal(isConversationEndRequest(message), false, message);
	}
});

test("disconnect during booking finalizes the successful appointment outcome", async () => {
	const store = new InMemoryConversationStore();
	let releaseBooking!: () => void;
	const pendingBooking = new Promise<void>((resolve) => {
		releaseBooking = resolve;
	});
	let finalizedAppointment: string | undefined;
	let finalizations = 0;
	const adapter = new LiveKitConversationAdapter(store, () => ({
		async handleMessage(_message, conversation) {
			await pendingBooking;
			const outcome = createConversationOutcome(
				"completed",
				"Appointment booked.",
				"appointment-after-disconnect",
			);
			conversation.recordOutcome(outcome);
			return { reply: "Booked", outcome };
		},
		async endConversation(conversation) {
			finalizations += 1;
			assert.equal(conversation.outcome?.status, "completed");
			finalizedAppointment = conversation.outcome?.appointmentId;
		},
	}));
	let transcript!: (message: string) => Promise<VoiceTurnResult>;
	const runtime = new LiveKitVoiceRuntime(adapter, async (_call, onTranscript) => {
		transcript = onTranscript;
		return { async close() {} };
	});
	await runtime.startCall({
		businessId: "maple-street-dog-grooming",
		conversationId: "booking-disconnect",
		roomName: "booking-disconnect",
		participantIdentity: "customer",
	});
	const turn = transcript("Yes, book it");
	await Promise.resolve();
	const shutdown = runtime.close();
	assert.equal(finalizations, 0);
	releaseBooking();
	await turn;
	await shutdown;
	assert.equal(finalizedAppointment, "appointment-after-disconnect");
	assert.equal(finalizations, 1);
});

test("hangs up only after farewell playback finishes", async () => {
	let finishPlayback!: () => void;
	const events: string[] = [];
	const playing = playVoiceReply(
		{ conversationId: "call-1", status: "answered", reply: "Goodbye!", endCall: true },
		{
			async playReply(reply) {
				events.push(reply);
				await new Promise<void>((resolve) => {
					finishPlayback = resolve;
				});
			},
			endCall() {
				events.push("disconnected");
			},
		},
	);
	assert.deepEqual(events, ["Goodbye!"]);
	finishPlayback();
	await playing;
	assert.deepEqual(events, ["Goodbye!", "disconnected"]);
});

test("still hangs up if farewell playback fails, but does not hang up after an ordinary reply", async () => {
	let disconnects = 0;
	const output = {
		async playReply() {
			throw new Error("TTS unavailable");
		},
		endCall() {
			disconnects += 1;
		},
	};
	await assert.rejects(
		playVoiceReply(
			{ conversationId: "call-1", status: "answered", reply: "Goodbye!", endCall: true },
			output,
		),
		/TTS unavailable/,
	);
	assert.equal(disconnects, 1);
	await assert.rejects(
		playVoiceReply(
			{ conversationId: "call-2", status: "answered", reply: "What time?" },
			output,
		),
		/TTS unavailable/,
	);
	assert.equal(disconnects, 1);
});

test("LiveKit returns a hangup signal despite log failure and preserves state for a successful retry", async () => {
	const store = new InMemoryConversationStore();
	let writes = 0;
	const adapter = new LiveKitConversationAdapter(store, () => ({
		async handleMessage() {
			return {
				reply: "Goodbye!",
				outcome: createConversationOutcome("needs_information", "Customer ended the call."),
			};
		},
		async endConversation() {
			writes += 1;
			if (writes === 1) throw new Error("Sheets unavailable");
		},
	}));
	const context = { businessId: "maple-street-dog-grooming", conversationId: "call-retry" };
	const result = await adapter.handleTurn({ context, message: "Please end the call" });
	assert.equal(result.endCall, true);
	assert.equal(result.reply, "Goodbye!");
	assert.ok(store.getConversation(context));
	await adapter.endCall(context);
	await adapter.endCall(context);
	assert.equal(writes, 2);
	assert.throws(() => store.getConversation(context));
});
