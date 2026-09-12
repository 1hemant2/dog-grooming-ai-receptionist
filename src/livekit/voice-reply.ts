import type { VoiceTurnResult } from "../models/voice-call.js";

export interface VoiceReplyOutput {
	playReply(reply: string): Promise<void>;
	endCall(): void;
}

// Stateless sequencing keeps SDK playback behind a testable side-effect boundary.
export async function playVoiceReply(
	result: VoiceTurnResult,
	output: VoiceReplyOutput,
): Promise<void> {
	try {
		await output.playReply(result.reply);
	} finally {
		// Honor a request to leave even if farewell synthesis or playback fails.
		if (result.endCall) output.endCall();
	}
}
