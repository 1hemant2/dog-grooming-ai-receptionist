import type { Request, RequestHandler, Response } from "express";

import { APPLICATION_CONFIG, findBusinessConfig } from "../config/constants.js";
import {
	ConversationNotFoundError,
	type InMemoryConversationStore,
} from "../models/conversation.js";

const E164_PHONE_PATTERN = /^\+[1-9]\d{7,14}$/;
const CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

interface ConversationRequestBody {
	callerPhone: string;
	message: string;
	conversationId: string | undefined;
}

export function createReceiveMessageController(
	conversationStore: InMemoryConversationStore,
): RequestHandler {
	return function receiveMessage(request: Request, response: Response): void {
		try {
			const businessId = readBusinessId(request);
			const businessConfig = findBusinessConfig(businessId);

			if (!businessConfig) {
				response.status(404).json({ error: "Business not found" });
				return;
			}

			const body = readConversationBody(request);
			const conversationId = conversationStore.receiveMessage({
				businessId,
				callerPhone: body.callerPhone,
				message: body.message,
				conversationId: body.conversationId,
			});

			response.status(202).json({
				conversationId,
				status: "received",
				reply: `Thanks for contacting ${businessConfig.name}. Your message has been received.`,
			});
		} catch (error) {
			handleConversationError(error, response);
		}
	};
}

function readBusinessId(request: Request): string {
	const businessId = request.get("X-Business-Id");

	if (!businessId || businessId.trim().length === 0) {
		throw new InvalidRequestError(400, "X-Business-Id header is required");
	}

	return businessId.trim();
}

function readConversationBody(request: Request): ConversationRequestBody {
	if (!request.is("application/json")) {
		throw new InvalidRequestError(415, "Content-Type must be application/json");
	}

	const body: unknown = request.body;
	if (!isObject(body)) {
		throw new InvalidRequestError(400, "Request body must be a JSON object");
	}

	const callerPhone = readRequiredString(body, "callerPhone");
	const message = readRequiredString(body, "message");
	const conversationId = readOptionalString(body, "conversationId");

	if (!E164_PHONE_PATTERN.test(callerPhone)) {
		throw new InvalidRequestError(400, "callerPhone must use E.164 format");
	}

	if (message.length > APPLICATION_CONFIG.maxMessageCharacters) {
		throw new InvalidRequestError(
			400,
			`message must not exceed ${APPLICATION_CONFIG.maxMessageCharacters} characters`,
		);
	}

	if (conversationId && !isValidConversationId(conversationId)) {
		throw new InvalidRequestError(
			400,
			"conversationId may contain only letters, numbers, hyphens, and underscores",
		);
	}

	return { callerPhone, message, conversationId };
}

function readRequiredString(body: Record<string, unknown>, field: string): string {
	const value = body[field];

	if (typeof value !== "string" || value.trim().length === 0) {
		throw new InvalidRequestError(400, `${field} is required`);
	}

	return value.trim();
}

function readOptionalString(body: Record<string, unknown>, field: string): string | undefined {
	const value = body[field];

	if (value === undefined) {
		return undefined;
	}

	if (typeof value !== "string" || value.trim().length === 0) {
		throw new InvalidRequestError(400, `${field} must be a non-empty string`);
	}

	return value.trim();
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isValidConversationId(value: string): boolean {
	return (
		value.length <= APPLICATION_CONFIG.maxConversationIdCharacters &&
		CONVERSATION_ID_PATTERN.test(value)
	);
}

function handleConversationError(error: unknown, response: Response): void {
	if (error instanceof ConversationNotFoundError) {
		response.status(404).json({ error: error.message });
		return;
	}

	if (error instanceof InvalidRequestError) {
		response.status(error.statusCode).json({ error: error.message });
		return;
	}

	console.error("Conversation request failed.", error);
	response.status(500).json({ error: "Internal server error" });
}

class InvalidRequestError extends Error {
	readonly statusCode: number;

	constructor(statusCode: number, message: string) {
		super(message);
		this.statusCode = statusCode;
	}
}
