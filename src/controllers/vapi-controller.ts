import { timingSafeEqual } from "node:crypto";

import type { Request, RequestHandler, Response } from "express";

import { APPLICATION_CONFIG, APPLICATION_PATTERNS, type VapiConfig } from "../config/constants.js";
import { isValidPhoneNumber } from "../models/customer.js";
import type { VapiCallHandler, VapiConversationTurn } from "../models/vapi.js";

interface VapiRequestBody {
	callId: string;
	calledPhoneNumber: string;
	callerPhone?: string;
	message: string;
	requestId?: string;
}

interface VapiEventBody {
	type: string;
	callId?: string;
	calledPhoneNumber?: string;
	callerPhone?: string;
}

interface VapiRequestTiming {
	route: string;
	requestStartedAt: Date;
	timerStartedAt: bigint;
	callId?: string;
	businessId?: string;
	eventType?: string;
	requestId?: string;
	messageCharacters?: number;
	callerPhoneProvided?: boolean;
	outcomeStatus?: string;
	errorName?: string;
	errorMessage?: string;
}

export function createVapiConversationController(
	config: VapiConfig | undefined,
	handler?: VapiCallHandler,
): RequestHandler {
	return async function receiveVapiConversationTurn(
		request: Request,
		response: Response,
	): Promise<void> {
		const timing = createVapiRequestTiming("/vapi/conversations/messages");
		registerVapiResponseLog(response, timing);

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
			timing.callId = body.callId;
			timing.messageCharacters = body.message.length;
			timing.callerPhoneProvided = body.callerPhone !== undefined;
			if (body.requestId !== undefined) {
				timing.requestId = body.requestId;
			}
			const businessId = resolveBusinessId(body.calledPhoneNumber, config);
			timing.businessId = businessId;
			console.info("Vapi conversation request received.", {
				businessId,
				conversationId: body.callId,
				requestId: body.requestId,
				messageCharacters: body.message.length,
				callerPhoneProvided: body.callerPhone !== undefined,
			});
			const context: VapiConversationTurn["context"] = {
				businessId,
				conversationId: body.callId,
			};

			if (body.callerPhone !== undefined) {
				context.callerPhone = body.callerPhone;
			}

			const result = await handler.handleTurn({
				context,
				message: body.message,
				...(body.requestId ? { requestId: body.requestId } : {}),
			});
			timing.outcomeStatus = result.status;
			response.status(200).json(result);
		} catch (error) {
			registerVapiError(timing, error);
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

export function createVapiEventController(
	config: VapiConfig | undefined,
	handler?: VapiCallHandler,
): RequestHandler {
	return async function receiveVapiEvent(request: Request, response: Response): Promise<void> {
		const timing = createVapiRequestTiming("/vapi/events");
		registerVapiResponseLog(response, timing);

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

			const body = readEventBody(request);
			timing.callerPhoneProvided = body.callerPhone !== undefined;
			timing.eventType = body.type;
			if (body.callId !== undefined) {
				timing.callId = body.callId;
			}
			console.info("Vapi event received.", {
				eventType: body.type,
				conversationId: body.callId,
				callerPhoneProvided: body.callerPhone !== undefined,
			});
			if (body.type !== "end-of-call-report") {
				timing.outcomeStatus = "ignored";
				response.status(200).json({ status: "ignored" });
				return;
			}

			if (!body.callId || !body.calledPhoneNumber || !body.callerPhone) {
				throw new VapiRequestError(400, "End-of-call report is missing call identity");
			}

			const businessId = resolveBusinessId(body.calledPhoneNumber, config);
			await handler.endCall({
				businessId,
				conversationId: body.callId,
				callerPhone: body.callerPhone,
			});
			timing.businessId = businessId;
			timing.outcomeStatus = "ended";
			response.status(200).json({ conversationId: body.callId, status: "ended" });
		} catch (error) {
			registerVapiError(timing, error);
			if (error instanceof VapiRequestError) {
				response.status(error.statusCode).json({ error: error.message });
				return;
			}

			console.error("Vapi event failed.", {
				errorName: error instanceof Error ? error.constructor.name : "UnknownError",
			});
			response.status(500).json({ error: "Internal server error" });
		}
	};
}

function createVapiRequestTiming(route: string): VapiRequestTiming {
	return {
		route,
		requestStartedAt: new Date(),
		timerStartedAt: process.hrtime.bigint(),
	};
}

function registerVapiResponseLog(response: Response, timing: VapiRequestTiming): void {
	response.once("finish", () => {
		console.info("Vapi HTTP request completed.", {
			route: timing.route,
			...(timing.businessId ? { businessId: timing.businessId } : {}),
			...(timing.callId ? { conversationId: timing.callId } : {}),
			...(timing.eventType ? { eventType: timing.eventType } : {}),
			...(timing.requestId ? { requestId: timing.requestId } : {}),
			...(timing.outcomeStatus ? { outcomeStatus: timing.outcomeStatus } : {}),
			...(timing.errorName ? { errorName: timing.errorName } : {}),
			...(timing.errorMessage ? { errorMessage: timing.errorMessage } : {}),
			requestStartedAt: timing.requestStartedAt.toISOString(),
			responseSentAt: new Date().toISOString(),
			durationMs: elapsedMilliseconds(timing.timerStartedAt),
			responseStatusCode: response.statusCode,
			...(timing.messageCharacters !== undefined
				? { messageCharacters: timing.messageCharacters }
				: {}),
			...(timing.callerPhoneProvided !== undefined
				? { callerPhoneProvided: timing.callerPhoneProvided }
				: {}),
		});
	});
}

function registerVapiError(timing: VapiRequestTiming, error: unknown): void {
	timing.errorName = error instanceof Error ? error.constructor.name : "UnknownError";
	if (error instanceof VapiRequestError) {
		timing.errorMessage = error.message;
	}
}

function elapsedMilliseconds(timerStartedAt: bigint): number {
	return Math.round(Number(process.hrtime.bigint() - timerStartedAt) / 1_000_000);
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
	const callerPhone = readOptionalCallerPhone(request.body);
	const message = readRequiredString(request.body, "message");
	const requestId = readOptionalString(request.body, "requestId");

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

	if (requestId !== undefined) {
		if (requestId.length > APPLICATION_CONFIG.maxConversationIdCharacters) {
			throw new VapiRequestError(400, "requestId is invalid");
		}

		body.requestId = requestId;
	}

	return body;
}

function readEventBody(request: Request): VapiEventBody {
	if (!request.is("application/json")) {
		throw new VapiRequestError(415, "Content-Type must be application/json");
	}

	if (!isObject(request.body) || !isObject(request.body.message)) {
		throw new VapiRequestError(400, "Request body must contain a Vapi message");
	}

	const message = request.body.message;
	const type = readRequiredString(message, "type");
	if (type !== "end-of-call-report") {
		return { type };
	}

	if (!isObject(message.call)) {
		throw new VapiRequestError(400, "End-of-call report must contain a call");
	}

	const call = message.call;
	const callId = readRequiredString(call, "id");
	const calledPhoneNumber = readNestedRequiredString(call, "phoneNumber", "number");
	const callerPhone = readNestedRequiredString(call, "customer", "number");

	if (
		callId.length > APPLICATION_CONFIG.maxConversationIdCharacters ||
		!APPLICATION_PATTERNS.conversationId.test(callId)
	) {
		throw new VapiRequestError(400, "call.id is invalid");
	}

	if (!isValidPhoneNumber(calledPhoneNumber)) {
		throw new VapiRequestError(400, "call.phoneNumber.number must use E.164 format");
	}

	if (!isValidPhoneNumber(callerPhone)) {
		throw new VapiRequestError(400, "call.customer.number must use E.164 format");
	}

	return { type, callId, calledPhoneNumber, callerPhone };
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

function readOptionalCallerPhone(body: Record<string, unknown>): string | undefined {
	const value = body.callerPhone;
	if (value === undefined || value === null) {
		return undefined;
	}

	if (typeof value !== "string") {
		throw new VapiRequestError(400, "callerPhone must be a non-empty string");
	}

	const callerPhone = value.trim();
	// Browser calls do not have customer.number, so Vapi may send an empty or unresolved template.
	if (
		callerPhone.length === 0 ||
		callerPhone === "{{customer.number}}" ||
		callerPhone === "{{ customer.number }}"
	) {
		return undefined;
	}

	return callerPhone;
}

function readNestedRequiredString(
	body: Record<string, unknown>,
	objectField: string,
	valueField: string,
): string {
	const nestedObject = body[objectField];
	if (!isObject(nestedObject)) {
		throw new VapiRequestError(400, `${objectField}.${valueField} is required`);
	}

	return readRequiredString(nestedObject, valueField);
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
