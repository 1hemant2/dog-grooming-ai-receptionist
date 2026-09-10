import { Router } from "express";

import {
	createEndConversationController,
	createReceiveMessageController,
} from "../controllers/conversation-controller.js";
import type { InMemoryConversationStore } from "../models/conversation.js";
import type { ConversationMessageHandler } from "../services/conversation-orchestrator.js";

export function createConversationRouter(
	conversationStore: InMemoryConversationStore,
	resolveOrchestrator?: (businessId: string) => ConversationMessageHandler | undefined,
): Router {
	const router = Router();
	const receiveMessage = createReceiveMessageController(conversationStore, resolveOrchestrator);
	const endConversation = createEndConversationController(conversationStore, resolveOrchestrator);

	router.post("/messages", receiveMessage);
	router.post("/:conversationId/end", endConversation);

	return router;
}
