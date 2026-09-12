import { getLiveKitConfig } from "../config/constants.js";
import type { LiveKitHttpOptions } from "../http/app.js";
import type { InMemoryConversationStore } from "../models/conversation.js";
import type { ConversationMessageHandler } from "../services/conversation-orchestrator.js";
import { LiveKitConversationAdapter } from "../services/livekit-conversation-adapter.js";
import {
	createLiveKitVoiceConnector,
	releaseLiveKitVoiceResources,
} from "../livekit/voice-connection.js";
import { LiveKitVoiceRuntime } from "../livekit/voice-runtime.js";

export function createLiveKitHttpOptions(
	conversationStore: InMemoryConversationStore,
	resolveOrchestrator: (businessId: string) => ConversationMessageHandler | undefined,
): LiveKitHttpOptions | undefined {
	const config = getLiveKitConfig();

	if (!config) {
		return undefined;
	}

	const callHandler = new LiveKitConversationAdapter(conversationStore, resolveOrchestrator);
	return {
		config,
		voiceHost: new LiveKitVoiceRuntime(
			callHandler,
			createLiveKitVoiceConnector(config),
			releaseLiveKitVoiceResources,
		),
	};
}
