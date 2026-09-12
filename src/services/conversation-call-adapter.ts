import { ConversationNotFoundError } from "../models/conversation.js";
import type {
	ConversationLookupInput,
	InMemoryConversationStore,
	ReceiveMessageInput,
} from "../models/conversation.js";
import type {
	VoiceCallContext,
	VoiceCallHandler,
	VoiceConversationTurn,
	VoiceTurnResult,
} from "../models/voice-call.js";
import type { ConversationMessageHandler } from "./conversation-orchestrator.js";
import { isConversationEndRequest } from "./customer-message-parser.js";

interface CallState {
	nextOperation: Promise<void>;
	completedRequests: Map<string, Promise<VoiceTurnResult>>;
	endRequested: boolean;
	finalizationPromise: Promise<void> | undefined;
	callLogFinalized: boolean;
}

export class ConversationCallAdapter implements VoiceCallHandler {
	private readonly callStates = new Map<string, CallState>();
	private readonly finalizedCallIds = new Set<string>();

	constructor(
		private readonly conversationStore: InMemoryConversationStore,
		private readonly resolveOrchestrator: (
			businessId: string,
		) => ConversationMessageHandler | undefined,
		private readonly channel: "vapi" | "livekit",
	) {}

	handleTurn(turn: VoiceConversationTurn): Promise<VoiceTurnResult> {
		const callId = turn.context.conversationId;

		if (this.finalizedCallIds.has(callId)) {
			return Promise.reject(new Error(`${this.channel} call has already ended`));
		}

		const state = this.getCallState(callId);
		if (state.endRequested) {
			return Promise.reject(new Error(`${this.channel} call is being finalized`));
		}

		if (turn.requestId) {
			const completedRequest = state.completedRequests.get(turn.requestId);
			if (completedRequest) {
				return completedRequest;
			}
		}

		const turnPromise = this.enqueue(state, () => this.processTurn(turn, state));
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

	endCall(context: VoiceCallContext): Promise<void> {
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

	private getCallState(callId: string): CallState {
		const existingState = this.callStates.get(callId);
		if (existingState) {
			return existingState;
		}

		const state: CallState = {
			nextOperation: Promise.resolve(),
			completedRequests: new Map(),
			endRequested: false,
			finalizationPromise: undefined,
			callLogFinalized: false,
		};
		this.callStates.set(callId, state);
		return state;
	}

	private enqueue<T>(state: CallState, operation: () => Promise<T>): Promise<T> {
		const operationPromise = state.nextOperation.then(operation);
		state.nextOperation = operationPromise.then(
			() => undefined,
			() => undefined,
		);
		return operationPromise;
	}

	private async processTurn(
		turn: VoiceConversationTurn,
		state: CallState,
	): Promise<VoiceTurnResult> {
		const conversationInput: ReceiveMessageInput = {
			businessId: turn.context.businessId,
			conversationId: turn.context.conversationId,
			message: turn.message,
		};

		if (turn.context.callerPhone !== undefined) {
			conversationInput.callerPhone = turn.context.callerPhone;
		}

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
		const response: VoiceTurnResult = {
			conversationId,
			status: result.outcome.status,
			reply: result.reply,
		};

		if (result.outcome.appointmentId) {
			response.appointmentId = result.outcome.appointmentId;
		}

		if (isConversationEndRequest(turn.message)) {
			state.endRequested = true;
			response.endCall = true;
			try {
				await this.finalizeCall(turn.context, state);
			} catch (error) {
				// A failed log write must not keep a customer on the call. Retain state for retry.
				console.error(`${this.channel} call log finalization failed.`, {
					conversationId,
					errorName: error instanceof Error ? error.name : "UnknownError",
				});
			}
		}

		console.info(`${this.channel} conversation turn completed.`, {
			message: turn.message,
			businessId: turn.context.businessId,
			conversationId,
			messageCharacters: turn.message.length,
			outcomeStatus: response.status,
		});

		return response;
	}

	private async finalizeCall(context: VoiceCallContext, state: CallState): Promise<void> {
		const lookupInput: ConversationLookupInput = {
			businessId: context.businessId,
			conversationId: context.conversationId,
		};

		if (context.callerPhone !== undefined) {
			lookupInput.callerPhone = context.callerPhone;
		}

		let conversation;
		try {
			conversation = this.conversationStore.getConversation(lookupInput);
		} catch (error) {
			if (!(error instanceof ConversationNotFoundError)) {
				throw error;
			}

			this.finalizedCallIds.add(context.conversationId);
			this.callStates.delete(context.conversationId);
			console.info(`${this.channel} call ended without conversation activity.`, {
				businessId: context.businessId,
				conversationId: context.conversationId,
			});
			return;
		}
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

		console.info(`${this.channel} call finalized.`, {
			businessId: context.businessId,
			conversationId: context.conversationId,
		});
	}
}
