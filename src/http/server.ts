import { createServer, type Server } from "node:http";

import type { InMemoryConversationStore } from "../models/conversation.js";
import type { ConversationMessageHandler } from "../services/conversation-orchestrator.js";
import { createHttpApp } from "./app.js";

export function createHttpServer(
	conversationStore: InMemoryConversationStore,
	resolveOrchestrator?: (businessId: string) => ConversationMessageHandler | undefined,
): Server {
	const app = createHttpApp(conversationStore, resolveOrchestrator);
	return createServer(app);
}

export async function closeServerGracefully(server: Server): Promise<void> {
	if (!server.listening) {
		return;
	}

	server.closeIdleConnections();

	await new Promise<void>((resolve, reject) => {
		server.close((error) => {
			if (error) {
				reject(error);
				return;
			}

			resolve();
		});
	});
}

export function registerShutdownSignals(server: Server, onShutdown?: () => void): void {
	let shuttingDown = false;

	const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
		if (shuttingDown) {
			return;
		}

		shuttingDown = true;
		console.info(`${signal} received; finishing active requests before shutdown.`);

		try {
			await closeServerGracefully(server);
			console.info("HTTP server stopped.");
		} catch (error) {
			console.error("HTTP server shutdown failed.", {
				errorName: error instanceof Error ? error.constructor.name : "UnknownError",
			});
			process.exitCode = 1;
		} finally {
			onShutdown?.();
		}
	};

	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
