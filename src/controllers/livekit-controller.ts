import { randomUUID } from "node:crypto";
import type { Request, RequestHandler, Response } from "express";
import { AccessToken } from "livekit-server-sdk";

import { findBusinessConfig, type LiveKitConfig } from "../config/constants.js";
import { isValidPhoneNumber } from "../models/customer.js";
import type { LiveKitVoiceHost } from "../models/livekit.js";

export function createLiveKitTokenController(
	config: LiveKitConfig | undefined,
	voiceHost?: LiveKitVoiceHost,
): RequestHandler {
	return async function createToken(request: Request, response: Response): Promise<void> {
		if (!config || !voiceHost) {
			response.status(503).json({ error: "LiveKit integration is not configured" });
			return;
		}
		const businessId = request.get("X-Business-Id")?.trim();
		if (!businessId) {
			response.status(400).json({ error: "X-Business-Id is required" });
			return;
		}
		if (!findBusinessConfig(businessId)) {
			response.status(404).json({ error: "Business not found" });
			return;
		}
		const callerPhone: unknown = request.body?.callerPhone;
		if (
			callerPhone !== undefined &&
			(typeof callerPhone !== "string" || !isValidPhoneNumber(callerPhone))
		) {
			response.status(400).json({ error: "callerPhone must use E.164 format" });
			return;
		}
		try {
			const conversationId = `livekit-${randomUUID()}`;
			const roomName = conversationId;
			const participantIdentity = `customer-${randomUUID()}`;
			const token = new AccessToken(config.apiKey, config.apiSecret, {
				identity: participantIdentity,
				name: "Customer",
				ttl: "2h",
			});
			token.addGrant({
				roomJoin: true,
				room: roomName,
				canPublish: true,
				canSubscribe: true,
			});
			const participantToken = await token.toJwt();
			await voiceHost.startCall({
				businessId,
				conversationId,
				roomName,
				participantIdentity,
				...(typeof callerPhone === "string" ? { callerPhone } : {}),
			});
			response.status(200).json({
				serverUrl: config.websocketUrl,
				participantToken,
				roomName,
				conversationId,
				participantIdentity,
			});
		} catch (error) {
			console.error("LiveKit voice setup failed.", {
				errorName: error instanceof Error ? error.name : "UnknownError",
			});
			response.status(500).json({ error: "LiveKit voice setup failed" });
		}
	};
}
