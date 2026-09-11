import { getVapiConfig } from "../config/constants.js";
import type { VapiHttpOptions } from "../http/app.js";
import type { InMemoryConversationStore } from "../models/conversation.js";
import type { ConversationMessageHandler } from "../services/conversation-orchestrator.js";
import { VapiConversationAdapter } from "../services/vapi-conversation-adapter.js";

export function createVapiHttpOptions(
	conversationStore: InMemoryConversationStore,
	resolveOrchestrator: (businessId: string) => ConversationMessageHandler | undefined,
): VapiHttpOptions | undefined {
	const config = getVapiConfig();

	if (!config) {
		return undefined;
	}

	return {
		config,
		turnHandler: new VapiConversationAdapter(conversationStore, resolveOrchestrator),
	};
}
