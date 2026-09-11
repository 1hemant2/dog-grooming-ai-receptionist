import { Router } from "express";

import type { VapiConfig } from "../config/constants.js";
import {
	createVapiConversationController,
	createVapiEventController,
} from "../controllers/vapi-controller.js";
import type { VapiCallHandler } from "../models/vapi.js";

export function createVapiRouter(
	config: VapiConfig | undefined,
	handler?: VapiCallHandler,
): Router {
	const router = Router();
	router.post("/conversations/messages", createVapiConversationController(config, handler));
	router.post("/events", createVapiEventController(config, handler));
	return router;
}
