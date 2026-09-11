import { APPLICATION_CONFIG, getVapiConfig } from "./config/constants.js";
import { createHttpServer, registerShutdownSignals } from "./http/server.js";
import { InMemoryConversationStore } from "./models/conversation.js";
import { createConversationOrchestratorResolver } from "./app/create-conversation-orchestrator-resolver.js";
import { ConversationFinalizer } from "./services/conversation-finalizer.js";

const conversationStore = new InMemoryConversationStore();
const resolveOrchestrator = createConversationOrchestratorResolver();
const vapiConfig = getVapiConfig();
const vapiOptions = vapiConfig ? { config: vapiConfig } : undefined;
const server = createHttpServer(conversationStore, resolveOrchestrator, vapiOptions);
const conversationFinalizer = new ConversationFinalizer(
	conversationStore,
	resolveOrchestrator,
	APPLICATION_CONFIG.conversationIdleTimeoutMs,
);
const conversationCleanupTimer = setInterval(() => {
	void conversationFinalizer.finalizeInactiveConversations();
}, APPLICATION_CONFIG.conversationCleanupIntervalMs);
conversationCleanupTimer.unref();

registerShutdownSignals(server, () => clearInterval(conversationCleanupTimer));

server.listen(APPLICATION_CONFIG.port, () => {
	console.log(`Receptionist listening on http://localhost:${APPLICATION_CONFIG.port}`);
});
