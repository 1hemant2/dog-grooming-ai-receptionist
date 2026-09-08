import express, { type Express, type NextFunction, type Request, type Response } from "express";

import { APPLICATION_CONFIG } from "../config/constants.js";
import type { InMemoryConversationStore } from "../models/conversation.js";
import { createConversationRouter } from "../routes/conversation-routes.js";

export function createHttpApp(conversationStore: InMemoryConversationStore): Express {
	const app = express();

	app.use(express.json({ limit: APPLICATION_CONFIG.maxRequestBytes }));
	app.get("/health", handleHealthCheck);
	app.use("/conversations", createConversationRouter(conversationStore));
	app.use(handleNotFound);
	app.use(handleExpressError);

	return app;
}

function handleHealthCheck(_request: Request, response: Response): void {
	response.status(200).json({ status: "ok", service: "receptionist" });
}

function handleNotFound(_request: Request, response: Response): void {
	response.status(404).json({ error: "Not found" });
}

function handleExpressError(
	error: unknown,
	_request: Request,
	response: Response,
	_next: NextFunction,
): void {
	// Express identifies error handlers by their four-parameter signature.
	void _next;

	if (hasErrorType(error, "entity.too.large")) {
		response.status(413).json({ error: "Request body is too large" });
		return;
	}

	if (hasErrorType(error, "entity.parse.failed")) {
		response.status(400).json({ error: "Request body must contain valid JSON" });
		return;
	}

	console.error("HTTP request failed.", error);
	response.status(500).json({ error: "Internal server error" });
}

function hasErrorType(error: unknown, expectedType: string): boolean {
	return (
		typeof error === "object" &&
		error !== null &&
		"type" in error &&
		error.type === expectedType
	);
}
