import type {
	VoiceCallContext,
	VoiceCallHandler,
	VoiceConversationTurn,
	VoiceTurnResult,
} from "./voice-call.js";

export type LiveKitCallContext = VoiceCallContext;
export type LiveKitConversationTurn = VoiceConversationTurn;
export type LiveKitTurnResult = VoiceTurnResult;
export type LiveKitCallHandler = VoiceCallHandler;

export interface LiveKitRoomCall extends LiveKitCallContext {
	roomName: string;
	participantIdentity: string;
}

export interface LiveKitVoiceHost {
	startCall(call: LiveKitRoomCall): Promise<void>;
	close(): Promise<void>;
}
