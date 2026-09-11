import type { ConversationOutcomeStatus } from "./receptionist.js";

export interface VapiCallContext {
	businessId: string;
	conversationId: string;
	callerPhone?: string;
}

export interface VapiConversationTurn {
	context: VapiCallContext;
	message: string;
}

export interface VapiTurnResult {
	conversationId: string;
	status: ConversationOutcomeStatus;
	reply: string;
	appointmentId?: string;
}

export interface VapiTurnHandler {
	handleTurn(turn: VapiConversationTurn): Promise<VapiTurnResult>;
}
