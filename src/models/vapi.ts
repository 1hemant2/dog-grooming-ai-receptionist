import type {
	VoiceCallContext,
	VoiceCallHandler,
	VoiceConversationTurn,
	VoiceTurnResult,
} from "./voice-call.js";

export type VapiCallContext = VoiceCallContext;
export type VapiConversationTurn = VoiceConversationTurn;
export type VapiTurnResult = VoiceTurnResult;
export type VapiTurnHandler = Pick<VoiceCallHandler, "handleTurn">;
export type VapiCallHandler = VoiceCallHandler;
