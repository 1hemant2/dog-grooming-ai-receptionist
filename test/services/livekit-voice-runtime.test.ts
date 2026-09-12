import assert from "node:assert/strict";
import { test } from "node:test";
import type { LiveKitCallHandler, LiveKitRoomCall } from "../../src/models/livekit.js";
import type { VoiceTurnResult } from "../../src/models/voice-call.js";
import { LiveKitVoiceRuntime, type ConnectLiveKitVoice } from "../../src/livekit/voice-runtime.js";

const context: LiveKitRoomCall = {
	businessId: "maple-street-dog-grooming",
	conversationId: "livekit-demo",
	roomName: "livekit-demo",
	participantIdentity: "customer-demo",
};

test("calls the injected backend handler directly for consecutive voice turns", async () => {
	const messages: string[] = [];
	const handler: LiveKitCallHandler = {
		async handleTurn(turn) {
			assert.equal(turn.context, context);
			messages.push(turn.message);
			return {
				conversationId: context.conversationId,
				status: "answered",
				reply: `Reply ${messages.length}`,
			};
		},
		async endCall(call) {
			assert.equal(call, context);
		},
	};
	let onTranscript!: (message: string) => Promise<VoiceTurnResult>;
	const runtime = new LiveKitVoiceRuntime(handler, async (_call, transcript) => {
		onTranscript = transcript;
		return { async close() {} };
	});
	await runtime.startCall(context);
	assert.equal((await onTranscript("First message")).reply, "Reply 1");
	assert.equal((await onTranscript("Second message")).reply, "Reply 2");
	assert.deepEqual(messages, ["First message", "Second message"]);
	await runtime.close();
});

test("disconnect waits for the active backend turn and finalizes only once", async () => {
	let release!: () => void;
	const pending = new Promise<void>((resolve) => {
		release = resolve;
	});
	const operations: string[] = [];
	const handler: LiveKitCallHandler = {
		async handleTurn() {
			operations.push("turn-started");
			await pending;
			operations.push("turn-finished");
			return { conversationId: context.conversationId, status: "answered", reply: "Done" };
		},
		async endCall() {
			operations.push("finalized");
		},
	};
	let onTranscript!: (message: string) => Promise<VoiceTurnResult>;
	let onClose!: () => void;
	const connect: ConnectLiveKitVoice = async (_call, transcript, closed) => {
		onTranscript = transcript;
		onClose = closed;
		return {
			async close() {
				operations.push("audio-closed");
				onClose();
			},
		};
	};
	const runtime = new LiveKitVoiceRuntime(handler, connect);
	await runtime.startCall(context);
	const turn = onTranscript("Customer question");
	await Promise.resolve();
	onClose();
	onClose();
	const shutdown = runtime.close();
	await assert.rejects(onTranscript("Too late"), /call has ended/);
	release();
	await turn;
	await shutdown;
	assert.equal(operations.filter((value) => value === "finalized").length, 1);
	assert.ok(operations.indexOf("turn-finished") < operations.indexOf("finalized"));
});

test("a failed backend turn does not block the next utterance", async () => {
	let attempts = 0;
	let onTranscript!: (message: string) => Promise<VoiceTurnResult>;
	const runtime = new LiveKitVoiceRuntime(
		{
			async handleTurn() {
				if (++attempts === 1) throw new Error("Provider unavailable");
				return {
					conversationId: context.conversationId,
					status: "answered",
					reply: "Recovered",
				};
			},
			async endCall() {},
		},
		async (_call, transcript) => {
			onTranscript = transcript;
			return { async close() {} };
		},
	);
	await runtime.startCall(context);
	await assert.rejects(onTranscript("First"), /Provider unavailable/);
	assert.equal((await onTranscript("Retry")).reply, "Recovered");
	await runtime.close();
	await assert.rejects(runtime.startCall(context), /shutting down/);
});

test("failed audio setup does not keep a call or prevent another attempt", async () => {
	let attempts = 0;
	const runtime = new LiveKitVoiceRuntime(
		{
			async handleTurn() {
				throw new Error("No transcript expected");
			},
			async endCall() {},
		},
		async () => {
			if (++attempts === 1) throw new Error("Connection failed");
			return { async close() {} };
		},
	);
	await assert.rejects(runtime.startCall(context), /Connection failed/);
	await runtime.startCall(context);
	await assert.rejects(runtime.startCall(context), /already exists/);
	await runtime.close();
});
