import type {
	ConversationLookupInput,
	InMemoryConversationStore,
	ReceiveMessageInput,
} from "../models/conversation.js";
import type {
	VapiCallContext,
	VapiCallHandler,
	VapiConversationTurn,
	VapiTurnResult,
} from "../models/vapi.js";
import type { ConversationMessageHandler } from "./conversation-orchestrator.js";

interface VapiCallState {
	nextOperation: Promise<void>;
	completedRequests: Map<string, Promise<VapiTurnResult>>;
	endRequested: boolean;
	finalizationPromise: Promise<void> | undefined;
	callLogFinalized: boolean;
}

export class VapiConversationAdapter implements VapiCallHandler {
	private readonly callStates = new Map<string, VapiCallState>();
	private readonly finalizedCallIds = new Set<string>();

	constructor(
		private readonly conversationStore: InMemoryConversationStore,
		private readonly resolveOrchestrator: (
			businessId: string,
		) => ConversationMessageHandler | undefined,
	) {}

	handleTurn(turn: VapiConversationTurn): Promise<VapiTurnResult> {
		const callId = turn.context.conversationId;

		if (this.finalizedCallIds.has(callId)) {
			return Promise.reject(new Error("Vapi call has already ended"));
		}

		const state = this.getCallState(callId);
		if (state.endRequested) {
			return Promise.reject(new Error("Vapi call is being finalized"));
		}

		if (turn.requestId) {
			const completedRequest = state.completedRequests.get(turn.requestId);
			if (completedRequest) {
				return completedRequest;
			}
		}

		const turnPromise = this.enqueue(state, () => this.processTurn(turn));
		if (turn.requestId) {
			const requestId = turn.requestId;
			state.completedRequests.set(requestId, turnPromise);
			void turnPromise.catch(() => {
				if (state.completedRequests.get(requestId) === turnPromise) {
					state.completedRequests.delete(requestId);
				}
			});
		}

		return turnPromise;
	}

	endCall(context: VapiCallContext): Promise<void> {
		const callId = context.conversationId;
		if (this.finalizedCallIds.has(callId)) {
			return Promise.resolve();
		}

		const state = this.getCallState(callId);
		if (state.finalizationPromise) {
			return state.finalizationPromise;
		}

		state.endRequested = true;
		const finalizationPromise = this.enqueue(state, () => this.finalizeCall(context, state));
		state.finalizationPromise = finalizationPromise;
		void finalizationPromise.catch(() => {
			if (state.finalizationPromise === finalizationPromise) {
				state.finalizationPromise = undefined;
			}
		});

		return finalizationPromise;
	}

	private getCallState(callId: string): VapiCallState {
		const existingState = this.callStates.get(callId);
		if (existingState) {
			return existingState;
		}

		const state: VapiCallState = {
			nextOperation: Promise.resolve(),
			completedRequests: new Map(),
			endRequested: false,
			finalizationPromise: undefined,
			callLogFinalized: false,
		};
		this.callStates.set(callId, state);
		return state;
	}

	private enqueue<T>(state: VapiCallState, operation: () => Promise<T>): Promise<T> {
		const operationPromise = state.nextOperation.then(operation);
		state.nextOperation = operationPromise.then(
			() => undefined,
			() => undefined,
		);
		return operationPromise;
	}

	private async processTurn(turn: VapiConversationTurn): Promise<VapiTurnResult> {
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

	private async finalizeCall(context: VapiCallContext, state: VapiCallState): Promise<void> {
		const lookupInput: ConversationLookupInput = {
			businessId: context.businessId,
			conversationId: context.conversationId,
		};

		if (context.callerPhone !== undefined) {
			lookupInput.callerPhone = context.callerPhone;
		}

		const conversation = this.conversationStore.getConversation(lookupInput);
		const orchestrator = this.resolveOrchestrator(context.businessId);

		if (!orchestrator) {
			throw new Error("No conversation orchestrator is configured for the business");
		}

		if (!state.callLogFinalized) {
			await orchestrator.endConversation(conversation);
			state.callLogFinalized = true;
		}

		this.conversationStore.endConversation(lookupInput);
		this.finalizedCallIds.add(context.conversationId);
		this.callStates.delete(context.conversationId);

		console.info("Vapi call finalized.", {
			businessId: context.businessId,
			conversationId: context.conversationId,
		});
	}
}

function elapsedMilliseconds(timerStartedAt: bigint): number {
	return Math.round(Number(process.hrtime.bigint() - timerStartedAt) / 1_000_000);
}
