import { Router } from "express";

import type { LiveKitConfig } from "../config/constants.js";
import { createLiveKitTokenController } from "../controllers/livekit-controller.js";
import type { LiveKitVoiceHost } from "../models/livekit.js";

export function createLiveKitRouter(
	config: LiveKitConfig | undefined,
	voiceHost?: LiveKitVoiceHost,
): Router {
	const router = Router();
	router.post("/token", createLiveKitTokenController(config, voiceHost));
	return router;
}
