import type { Request, RequestHandler, Response } from "express";

import { APPLICATION_CONFIG, findBusinessConfig } from "../config/constants.js";
import {
	ConversationNotFoundError,
	type ConversationLookupInput,
	type ReceiveMessageInput,
	type InMemoryConversationStore,
} from "../models/conversation.js";
import { isValidPhoneNumber } from "../models/customer.js";
import type { ConversationMessageHandler } from "../services/conversation-orchestrator.js";

const CONVERSATION_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

interface ConversationRequestBody {
	callerPhone?: string;
	message: string;
	conversationId: string | undefined;
}

export function createReceiveMessageController(
	conversationStore: InMemoryConversationStore,
	resolveOrchestrator?: (businessId: string) => ConversationMessageHandler | undefined,
): RequestHandler {
	return async function receiveMessage(request: Request, response: Response): Promise<void> {
		try {
			const businessId = readBusinessId(request);
			const businessConfig = findBusinessConfig(businessId);

			if (!businessConfig) {
				response.status(404).json({ error: "Business not found" });
				return;
			}

			const body = readConversationBody(request);
			const conversationInput: ReceiveMessageInput = {
				businessId,
				message: body.message,
				conversationId: body.conversationId,
			};

			if (body.callerPhone !== undefined) {
				conversationInput.callerPhone = body.callerPhone;
			}

			const conversationId = conversationStore.receiveMessage(conversationInput);
			const lookupInput: ConversationLookupInput = {
				businessId,
				conversationId,
			};

			if (body.callerPhone !== undefined) {
				lookupInput.callerPhone = body.callerPhone;
			}

			const conversation = conversationStore.getConversation(lookupInput);
			const orchestrator = resolveOrchestrator?.(businessId);

			if (orchestrator) {
				const result = await orchestrator.handleMessage(body.message, conversation);
				console.info("Conversation request completed.", {
					businessId,
					conversationId,
					outcomeStatus: result.outcome.status,
					...(result.outcome.appointmentId
						? { appointmentId: result.outcome.appointmentId }
						: {}),
				});

				response.status(200).json({
					conversationId,
					status: result.outcome.status,
					reply: result.reply,
					...(result.outcome.appointmentId
						? { appointmentId: result.outcome.appointmentId }
						: {}),
				});
				return;
			}

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

export function createEndConversationController(
	conversationStore: InMemoryConversationStore,
	resolveOrchestrator?: (businessId: string) => ConversationMessageHandler | undefined,
): RequestHandler {
	return async function endConversation(request: Request, response: Response): Promise<void> {
		try {
			const businessId = readBusinessId(request);
			const businessConfig = findBusinessConfig(businessId);

			if (!businessConfig) {
				response.status(404).json({ error: "Business not found" });
				return;
			}

			const conversationId = request.params.conversationId;
			if (typeof conversationId !== "string" || !isValidConversationId(conversationId)) {
				throw new InvalidRequestError(400, "conversationId is invalid");
			}

			const callerPhone = readEndConversationCallerPhone(request);
			const lookupInput: ConversationLookupInput = { businessId, conversationId };

			if (callerPhone !== undefined) {
				lookupInput.callerPhone = callerPhone;
			}

			const conversation = conversationStore.getConversation(lookupInput);
			const orchestrator = resolveOrchestrator?.(businessId);

			if (!orchestrator) {
				response.status(503).json({ error: "Conversation services are unavailable" });
				return;
			}

			await orchestrator.endConversation(conversation);
			conversationStore.endConversation(lookupInput);

			response.status(200).json({ conversationId, status: "ended" });
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

	const callerPhone = readOptionalString(body, "callerPhone");
	const message = readRequiredString(body, "message");
	const conversationId = readOptionalString(body, "conversationId");

	if (callerPhone !== undefined && !isValidPhoneNumber(callerPhone)) {
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

	const conversationBody: ConversationRequestBody = { message, conversationId };

	if (callerPhone !== undefined) {
		conversationBody.callerPhone = callerPhone;
	}

	return conversationBody;
}

function readEndConversationCallerPhone(request: Request): string | undefined {
	if (request.body === undefined) {
		return undefined;
	}

	if (!isObject(request.body)) {
		throw new InvalidRequestError(400, "Request body must be a JSON object");
	}

	const callerPhone = readOptionalString(request.body, "callerPhone");
	if (callerPhone !== undefined && !isValidPhoneNumber(callerPhone)) {
		throw new InvalidRequestError(400, "callerPhone must use E.164 format");
	}

	return callerPhone;
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

	const errorMessage = error instanceof Error ? error.message : String(error);
	console.error(`Conversation request failed: ${errorMessage}`, {
		errorName: error instanceof Error ? error.constructor.name : "UnknownError",
		errorMessage,
	});
	response.status(500).json({ error: "Internal server error" });
}

class InvalidRequestError extends Error {
	readonly statusCode: number;

	constructor(statusCode: number, message: string) {
		super(message);
		this.statusCode = statusCode;
	}
}
