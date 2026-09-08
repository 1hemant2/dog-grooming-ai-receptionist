import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export function createHttpServer(): Server {
	return createServer(handleRequest);
}

function handleRequest(request: IncomingMessage, response: ServerResponse): void {
	if (request.method === "GET" && request.url === "/health") {
		response.writeHead(200, { "content-type": "application/json" });
		response.end(JSON.stringify({ status: "ok", service: "receptionist" }));
		return;
	}

	response.writeHead(404, { "content-type": "application/json" });
	response.end(JSON.stringify({ error: "Not found" }));
}

export async function closeServerGracefully(server: Server): Promise<void> {
	if (!server.listening) {
		return;
	}

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

export function registerShutdownSignals(server: Server): void {
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
			console.error("HTTP server shutdown failed.", error);
			process.exitCode = 1;
		}
	};

	process.once("SIGINT", () => void shutdown("SIGINT"));
	process.once("SIGTERM", () => void shutdown("SIGTERM"));
}
