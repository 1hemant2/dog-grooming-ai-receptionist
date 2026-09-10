import type { InMemoryConversationStore } from "../models/conversation.js";
import type { ConversationMessageHandler } from "./conversation-orchestrator.js";

export type ConversationOrchestratorResolver = (
	businessId: string,
) => ConversationMessageHandler | undefined;

export class ConversationFinalizer {
	private finalizationInProgress = false;

	constructor(
		private readonly conversationStore: InMemoryConversationStore,
		private readonly resolveOrchestrator: ConversationOrchestratorResolver,
		private readonly idleTimeoutMs: number,
		private readonly clock: () => Date = () => new Date(),
	) {}

	async finalizeInactiveConversations(): Promise<number> {
		if (this.finalizationInProgress) return 0;

		this.finalizationInProgress = true;
		let finalizedCount = 0;

		try {
			const inactiveConversations = this.conversationStore.getInactiveConversations(
				this.idleTimeoutMs,
				this.clock(),
			);

			for (const conversation of inactiveConversations) {
				if (!conversation.isInactive(this.clock(), this.idleTimeoutMs)) {
					continue;
				}

				const orchestrator = this.resolveOrchestrator(conversation.businessId);
				if (!orchestrator) {
					console.error("Inactive conversation could not be finalized.", {
						businessId: conversation.businessId,
						conversationId: conversation.id,
						errorName: "ConversationOrchestratorUnavailable",
					});
					continue;
				}

				try {
					await orchestrator.endConversation(conversation);
					this.conversationStore.endConversation({
						businessId: conversation.businessId,
						conversationId: conversation.id,
					});
					finalizedCount += 1;
				} catch (error) {
					console.error("Inactive conversation finalization failed.", {
						businessId: conversation.businessId,
						conversationId: conversation.id,
						errorName: error instanceof Error ? error.constructor.name : "UnknownError",
					});
				}
			}
		} finally {
			this.finalizationInProgress = false;
		}

		return finalizedCount;
	}
}
