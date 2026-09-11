import { timingSafeEqual } from "node:crypto";

import type { Request, RequestHandler, Response } from "express";

import { APPLICATION_CONFIG, APPLICATION_PATTERNS, type VapiConfig } from "../config/constants.js";
import { isValidPhoneNumber } from "../models/customer.js";
import type { VapiConversationTurn, VapiTurnHandler } from "../models/vapi.js";

interface VapiRequestBody {
	callId: string;
	calledPhoneNumber: string;
	callerPhone?: string;
	message: string;
}

export function createVapiConversationController(
	config: VapiConfig | undefined,
	handler?: VapiTurnHandler,
): RequestHandler {
	return async function receiveVapiConversationTurn(
		request: Request,
		response: Response,
	): Promise<void> {
		try {
			if (!config) {
				response.status(503).json({ error: "Vapi integration is not configured" });
				return;
			}

			if (!hasValidAuthorization(request, config.serverToken)) {
				response.status(401).json({ error: "Unauthorized" });
				return;
			}

			if (!handler) {
				response.status(503).json({ error: "Vapi integration is not configured" });
				return;
			}

			const body = readRequestBody(request);
			const businessId = resolveBusinessId(body.calledPhoneNumber, config);
			const context: VapiConversationTurn["context"] = {
				businessId,
				conversationId: body.callId,
			};

			if (body.callerPhone !== undefined) {
				context.callerPhone = body.callerPhone;
			}

			const result = await handler.handleTurn({ context, message: body.message });
			response.status(200).json(result);
		} catch (error) {
			if (error instanceof VapiRequestError) {
				response.status(error.statusCode).json({ error: error.message });
				return;
			}

			console.error("Vapi request failed.", {
				errorName: error instanceof Error ? error.constructor.name : "UnknownError",
			});
			response.status(500).json({ error: "Internal server error" });
		}
	};
}

function hasValidAuthorization(request: Request, serverToken: string): boolean {
	const authorization = request.get("Authorization");
	if (!authorization?.startsWith("Bearer ")) {
		return false;
	}

	const receivedToken = Buffer.from(authorization.slice("Bearer ".length));
	const expectedToken = Buffer.from(serverToken);

	return (
		receivedToken.length === expectedToken.length &&
		timingSafeEqual(receivedToken, expectedToken)
	);
}

function readRequestBody(request: Request): VapiRequestBody {
	if (!request.is("application/json")) {
		throw new VapiRequestError(415, "Content-Type must be application/json");
	}

	if (!isObject(request.body)) {
		throw new VapiRequestError(400, "Request body must be a JSON object");
	}

	const callId = readRequiredString(request.body, "callId");
	const calledPhoneNumber = readRequiredString(request.body, "calledPhoneNumber");
	const callerPhone = readOptionalString(request.body, "callerPhone");
	const message = readRequiredString(request.body, "message");

	if (
		callId.length > APPLICATION_CONFIG.maxConversationIdCharacters ||
		!APPLICATION_PATTERNS.conversationId.test(callId)
	) {
		throw new VapiRequestError(400, "callId is invalid");
	}

	if (!isValidPhoneNumber(calledPhoneNumber)) {
		throw new VapiRequestError(400, "calledPhoneNumber must use E.164 format");
	}

	if (callerPhone !== undefined && !isValidPhoneNumber(callerPhone)) {
		throw new VapiRequestError(400, "callerPhone must use E.164 format");
	}

	if (message.length > APPLICATION_CONFIG.maxMessageCharacters) {
		throw new VapiRequestError(
			400,
			`message must not exceed ${APPLICATION_CONFIG.maxMessageCharacters} characters`,
		);
	}

	const body: VapiRequestBody = { callId, calledPhoneNumber, message };
	if (callerPhone !== undefined) {
		body.callerPhone = callerPhone;
	}

	return body;
}

function resolveBusinessId(calledPhoneNumber: string, config: VapiConfig): string {
	for (const mapping of config.businessPhoneMappings) {
		if (mapping.phoneNumber === calledPhoneNumber) {
			return mapping.businessId;
		}
	}

	throw new VapiRequestError(404, "Business not found for the called phone number");
}

function readRequiredString(body: Record<string, unknown>, field: string): string {
	const value = body[field];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new VapiRequestError(400, `${field} is required`);
	}

	return value.trim();
}

function readOptionalString(body: Record<string, unknown>, field: string): string | undefined {
	const value = body[field];
	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== "string" || value.trim().length === 0) {
		throw new VapiRequestError(400, `${field} must be a non-empty string`);
	}

	return value.trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

class VapiRequestError extends Error {
	constructor(
		readonly statusCode: number,
		message: string,
	) {
		super(message);
		this.name = "VapiRequestError";
	}
}
