import { APPLICATION_CONFIG } from "./config/constants.js";
import { createHttpServer, registerShutdownSignals } from "./http/server.js";
import { InMemoryConversationStore } from "./models/conversation.js";
import { createConversationOrchestratorResolver } from "./app/create-conversation-orchestrator-resolver.js";

const conversationStore = new InMemoryConversationStore();
const resolveOrchestrator = createConversationOrchestratorResolver();
const server = createHttpServer(conversationStore, resolveOrchestrator);

registerShutdownSignals(server);

server.listen(APPLICATION_CONFIG.port, () => {
	console.log(`Receptionist listening on http://localhost:${APPLICATION_CONFIG.port}`);
});
