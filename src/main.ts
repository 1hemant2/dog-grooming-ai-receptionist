import { APPLICATION_CONFIG } from "./config/constants.js";
import { createHttpServer, registerShutdownSignals } from "./http/server.js";
import { InMemoryConversationStore } from "./models/conversation.js";

const conversationStore = new InMemoryConversationStore();
const server = createHttpServer(conversationStore);

registerShutdownSignals(server);

server.listen(APPLICATION_CONFIG.port, () => {
	console.log(`Receptionist listening on http://localhost:${APPLICATION_CONFIG.port}`);
});
