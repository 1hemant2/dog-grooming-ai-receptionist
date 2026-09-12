import type { InMemoryConversationStore } from "../models/conversation.js";
import type { ConversationMessageHandler } from "./conversation-orchestrator.js";
import { ConversationCallAdapter } from "./conversation-call-adapter.js";

export class LiveKitConversationAdapter extends ConversationCallAdapter {
	constructor(
		conversationStore: InMemoryConversationStore,
		resolveOrchestrator: (businessId: string) => ConversationMessageHandler | undefined,
	) {
		super(conversationStore, resolveOrchestrator, "livekit");
	}
}
