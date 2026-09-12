import { AgentSessionEventTypes, inference, initializeLogger, llm, voice } from "@livekit/agents";
import { Room, dispose } from "@livekit/rtc-node";
import { AccessToken } from "livekit-server-sdk";

import type { LiveKitConfig } from "../config/constants.js";
import type { LiveKitRoomCall } from "../models/livekit.js";
import type { VoiceTurnResult } from "../models/voice-call.js";
import type { ConnectLiveKitVoice } from "./voice-runtime.js";
import { playVoiceReply } from "./voice-reply.js";

/** Release the process-wide native RTC runtime only after every call has closed. */
export async function releaseLiveKitVoiceResources(): Promise<void> {
	await dispose();
}

/** Uses the SDK's room/session primitives without its subprocess-based worker runner. */
export function createLiveKitVoiceConnector(config: LiveKitConfig): ConnectLiveKitVoice {
	initializeLogger({ pretty: false, level: "warn" });
	return async function connect(call, onTranscript, onClose) {
		const room = new Room();
		const stt = new inference.STT({
			model: "deepgram/nova-3",
			language: "en-IN",
			modelOptions: {
				// Keep digit pauses together and ask Deepgram to normalize spoken numbers.
				endpointing: 1500,
				numerals: true,
				smart_format: true,
				keyterm: [
					"Bath",
					"Bath and Trim",
					"Full Groom",
					"Hemant",
					"Maple Street Dog Grooming",
				],
			},
			apiKey: config.apiKey,
			apiSecret: config.apiSecret,
		});
		const tts = new inference.TTS({
			model: "inworld/inworld-tts-2",
			voice: "Ashley",
			apiKey: config.apiKey,
			apiSecret: config.apiSecret,
		});
		const session = new voice.AgentSession({
			stt,
			tts,
			vad: null,
			turnHandling: {
				turnDetection: "stt",
				endpointing: { minDelay: 1500, maxDelay: 5000 },
				interruption: { enabled: false },
			},
		});
		const agent = new BackendVoiceAgent(onTranscript);
		let closing: Promise<void> | undefined;
		let ready = false;
		let greeted = false;
		function greetCustomer(): void {
			if (!ready || greeted || closing) return;
			if (
				!Array.from(room.remoteParticipants.values()).some(
					(participant) => participant.identity === call.participantIdentity,
				)
			)
				return;
			greeted = true;
			clearTimeout(joinTimeout);
			void agent.greet().catch(reportVoiceFailure);
		}
		const joinTimeout = setTimeout(() => {
			void close().catch(reportVoiceFailure);
		}, 60_000);
		joinTimeout.unref();
		room.on("participantConnected", (participant) => {
			if (participant.identity === call.participantIdentity) greetCustomer();
		});
		session.on(AgentSessionEventTypes.Close, onClose);
		session.on(AgentSessionEventTypes.Error, () => {
			console.error("LiveKit audio provider error.", { conversationId: call.conversationId });
		});

		function close(): Promise<void> {
			if (closing) return closing;
			closing = dispose();
			return closing;
		}
		async function dispose(): Promise<void> {
			clearTimeout(joinTimeout);
			try {
				await session.close();
			} finally {
				try {
					await room.disconnect();
				} finally {
					await tts.close();
				}
			}
		}

		try {
			const token = await createAgentToken(config, call);
			await room.connect(config.websocketUrl, token);
			await session.start({
				agent,
				room,
				record: false,
				inputOptions: { participantIdentity: call.participantIdentity },
			});
			ready = true;
			greetCustomer();
			return { close };
		} catch (error) {
			await close().catch(reportVoiceFailure);
			throw error;
		}
	};
}

class BackendVoiceAgent extends voice.Agent {
	constructor(private readonly onTranscript: (message: string) => Promise<VoiceTurnResult>) {
		super({
			instructions: "Speak only the reply supplied by the receptionist conversation handler.",
		});
	}

	override async onUserTurnCompleted(
		_chatCtx: llm.ChatContext,
		message: llm.ChatMessage,
	): Promise<void> {
		const transcript = message.textContent?.trim();
		if (!transcript) return;
		try {
			const result = await this.onTranscript(transcript);
			// Do not await playout inside the SDK turn hook: its scheduler owns this task.
			void this.speakReply(result).catch(reportVoiceFailure);
		} catch (error) {
			reportVoiceFailure(error);
			this.session.say("Sorry, I couldn't process that. Could you try again?", {
				allowInterruptions: false,
			});
		}
	}

	async greet(): Promise<void> {
		await this.session.say("Hello! How can I help with your dog's grooming today?", {
			allowInterruptions: false,
		});
	}

	private async speakReply(result: VoiceTurnResult): Promise<void> {
		await playVoiceReply(result, {
			playReply: async (reply) => {
				await this.session.say(reply, { allowInterruptions: false });
			},
			endCall: () => this.session.shutdown({ drain: true, reason: "customer-ended-call" }),
		});
	}
}

async function createAgentToken(config: LiveKitConfig, call: LiveKitRoomCall): Promise<string> {
	const token = new AccessToken(config.apiKey, config.apiSecret, {
		identity: `agent-${call.conversationId}`,
		name: config.agentName,
		ttl: "2h",
	});
	// This participant joins directly; no agent dispatch or worker registration is needed.
	token.addGrant({
		roomJoin: true,
		room: call.roomName,
		canPublish: true,
		canSubscribe: true,
		agent: true,
	});
	return token.toJwt();
}

function reportVoiceFailure(error: unknown): void {
	console.error("LiveKit voice operation failed.", {
		errorName: error instanceof Error ? error.name : "UnknownError",
	});
}
