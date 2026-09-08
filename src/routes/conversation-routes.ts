import { Router } from "express";

import { createReceiveMessageController } from "../controllers/conversation-controller.js";
import type { InMemoryConversationStore } from "../models/conversation.js";

export function createConversationRouter(conversationStore: InMemoryConversationStore): Router {
	const router = Router();
	const receiveMessage = createReceiveMessageController(conversationStore);

	router.post("/messages", receiveMessage);

	return router;
}
