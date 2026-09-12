import { createConversationOrchestratorResolver } from "./app/create-conversation-orchestrator-resolver.js";
import { createLiveKitHttpOptions } from "./app/create-livekit-http-options.js";
import { createVapiHttpOptions } from "./app/create-vapi-http-options.js";
import { APPLICATION_CONFIG } from "./config/constants.js";
import { createHttpServer, registerShutdownSignals } from "./http/server.js";
import { InMemoryConversationStore } from "./models/conversation.js";
import { ConversationFinalizer } from "./services/conversation-finalizer.js";

const conversationStore = new InMemoryConversationStore();
const resolveOrchestrator = createConversationOrchestratorResolver();
const vapiOptions = createVapiHttpOptions(conversationStore, resolveOrchestrator);
const liveKitOptions = createLiveKitHttpOptions(conversationStore, resolveOrchestrator);
const server = createHttpServer(
	conversationStore,
	resolveOrchestrator,
	vapiOptions,
	liveKitOptions,
);
const conversationFinalizer = new ConversationFinalizer(
	conversationStore,
	resolveOrchestrator,
	APPLICATION_CONFIG.conversationIdleTimeoutMs,
);
const conversationCleanupTimer = setInterval(() => {
	void conversationFinalizer.finalizeInactiveConversations();
}, APPLICATION_CONFIG.conversationCleanupIntervalMs);
conversationCleanupTimer.unref();

registerShutdownSignals(server, async () => {
	clearInterval(conversationCleanupTimer);
	await liveKitOptions?.voiceHost?.close();
});

server.listen(APPLICATION_CONFIG.port, () => {
	console.log(`Receptionist listening on http://localhost:${APPLICATION_CONFIG.port}`);
});
