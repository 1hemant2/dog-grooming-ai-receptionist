import type { ConversationOutcomeStatus } from "./receptionist.js";

export interface VapiCallContext {
	businessId: string;
	conversationId: string;
	callerPhone?: string;
}

export interface VapiConversationTurn {
	context: VapiCallContext;
	message: string;
	requestId?: string;
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

export interface VapiCallHandler extends VapiTurnHandler {
	endCall(context: VapiCallContext): Promise<void>;
}
