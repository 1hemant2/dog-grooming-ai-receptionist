import type { ConversationOutcomeStatus } from "./receptionist.js";

export interface VoiceCallContext {
	businessId: string;
	conversationId: string;
	callerPhone?: string;
}

export interface VoiceConversationTurn {
	context: VoiceCallContext;
	message: string;
	requestId?: string;
}

export interface VoiceTurnResult {
	conversationId: string;
	status: ConversationOutcomeStatus;
	reply: string;
	endCall?: boolean;
	appointmentId?: string;
}

export interface VoiceCallHandler {
	handleTurn(turn: VoiceConversationTurn): Promise<VoiceTurnResult>;
	endCall(context: VoiceCallContext): Promise<void>;
}
