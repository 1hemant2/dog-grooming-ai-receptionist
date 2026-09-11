import type {
	ConversationLookupInput,
	InMemoryConversationStore,
	ReceiveMessageInput,
} from "../models/conversation.js";
import type { VapiConversationTurn, VapiTurnHandler, VapiTurnResult } from "../models/vapi.js";
import type { ConversationMessageHandler } from "./conversation-orchestrator.js";

export class VapiConversationAdapter implements VapiTurnHandler {
	constructor(
		private readonly conversationStore: InMemoryConversationStore,
		private readonly resolveOrchestrator: (
			businessId: string,
		) => ConversationMessageHandler | undefined,
	) {}

	async handleTurn(turn: VapiConversationTurn): Promise<VapiTurnResult> {
		const timerStartedAt = process.hrtime.bigint();
		const conversationInput: ReceiveMessageInput = {
			businessId: turn.context.businessId,
			conversationId: turn.context.conversationId,
			message: turn.message,
		};

		if (turn.context.callerPhone !== undefined) {
			conversationInput.callerPhone = turn.context.callerPhone;
		}

		try {
			const conversationId = this.conversationStore.receiveMessage(conversationInput);
			const lookupInput: ConversationLookupInput = {
				businessId: turn.context.businessId,
				conversationId,
			};

			if (turn.context.callerPhone !== undefined) {
				lookupInput.callerPhone = turn.context.callerPhone;
			}

			const conversation = this.conversationStore.getConversation(lookupInput);
			const orchestrator = this.resolveOrchestrator(turn.context.businessId);

			if (!orchestrator) {
				throw new Error("No conversation orchestrator is configured for the business");
			}

			const result = await orchestrator.handleMessage(turn.message, conversation);
			const response: VapiTurnResult = {
				conversationId,
				status: result.outcome.status,
				reply: result.reply,
			};

			if (result.outcome.appointmentId) {
				response.appointmentId = result.outcome.appointmentId;
			}

			console.info("Vapi conversation turn completed.", {
				businessId: turn.context.businessId,
				conversationId,
				durationMs: elapsedMilliseconds(timerStartedAt),
				messageCharacters: turn.message.length,
				outcomeStatus: response.status,
			});

			return response;
		} catch (error) {
			console.error("Vapi conversation turn failed.", {
				businessId: turn.context.businessId,
				conversationId: turn.context.conversationId,
				durationMs: elapsedMilliseconds(timerStartedAt),
				messageCharacters: turn.message.length,
				errorName: error instanceof Error ? error.constructor.name : "UnknownError",
			});
			throw error;
		}
	}
}

function elapsedMilliseconds(timerStartedAt: bigint): number {
	return Math.round(Number(process.hrtime.bigint() - timerStartedAt) / 1_000_000);
}
