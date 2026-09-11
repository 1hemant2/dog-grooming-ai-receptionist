import { Router } from "express";

import type { VapiConfig } from "../config/constants.js";
import { createVapiConversationController } from "../controllers/vapi-controller.js";
import type { VapiTurnHandler } from "../models/vapi.js";

export function createVapiRouter(
	config: VapiConfig | undefined,
	handler?: VapiTurnHandler,
): Router {
	const router = Router();
	router.post("/conversations/messages", createVapiConversationController(config, handler));
	return router;
}
