import type { LiveKitCallHandler, LiveKitRoomCall, LiveKitVoiceHost } from "../models/livekit.js";
import type { VoiceTurnResult } from "../models/voice-call.js";

export interface LiveKitVoiceConnection {
	close(): Promise<void>;
}

export type ConnectLiveKitVoice = (
	call: LiveKitRoomCall,
	onTranscript: (message: string) => Promise<VoiceTurnResult>,
	onClose: () => void,
) => Promise<LiveKitVoiceConnection>;

interface ActiveCall {
	context: LiveKitRoomCall;
	connection: Promise<LiveKitVoiceConnection>;
	nextTurn: Promise<void>;
	closing: boolean;
	finalization?: Promise<void>;
}

/** Owns voice calls in the HTTP server process and shares its conversation handler. */
export class LiveKitVoiceRuntime implements LiveKitVoiceHost {
	private readonly calls = new Map<string, ActiveCall>();
	private closed = false;

	constructor(
		private readonly handler: LiveKitCallHandler,
		private readonly connect: ConnectLiveKitVoice,
		private readonly releaseResources: () => Promise<void> = async () => {},
	) {}

	async startCall(context: LiveKitRoomCall): Promise<void> {
		if (this.closed) throw new Error("LiveKit voice is shutting down");
		if (this.calls.has(context.conversationId)) throw new Error("LiveKit call already exists");

		const call: ActiveCall = {
			context,
			connection: Promise.resolve().then(() =>
				this.connect(
					context,
					(message) => this.handleTranscript(call, message),
					() => {
						void this.finishCall(call).catch(reportCallFailure);
					},
				),
			),
			nextTurn: Promise.resolve(),
			closing: false,
		};
		this.calls.set(context.conversationId, call);
		try {
			await call.connection;
			if (call.closing) throw new Error("LiveKit call closed during setup");
		} catch (error) {
			this.calls.delete(context.conversationId);
			throw error;
		}
	}

	async close(): Promise<void> {
		this.closed = true;
		const results = await Promise.allSettled(
			Array.from(this.calls.values(), (call) => this.finishCall(call)),
		);
		await this.releaseResources();
		const failures = results.filter((result) => result.status === "rejected");
		if (failures.length)
			throw new AggregateError(
				failures.map((result) => result.reason),
				"LiveKit shutdown failed",
			);
	}

	private handleTranscript(call: ActiveCall, message: string): Promise<VoiceTurnResult> {
		if (call.closing) return Promise.reject(new Error("LiveKit call has ended"));
		const turn = call.nextTurn.then(() =>
			this.handler.handleTurn({
				context: call.context,
				message,
			}),
		);
		call.nextTurn = turn.then(
			() => undefined,
			() => undefined,
		);
		return turn;
	}

	private finishCall(call: ActiveCall): Promise<void> {
		if (call.finalization) return call.finalization;
		call.closing = true;
		call.finalization = this.finalizeCall(call);
		return call.finalization;
	}

	private async finalizeCall(call: ActiveCall): Promise<void> {
		try {
			const connection = await call.connection;
			await connection.close();
			await call.nextTurn;
			await this.handler.endCall(call.context);
		} finally {
			this.calls.delete(call.context.conversationId);
		}
	}
}

function reportCallFailure(error: unknown): void {
	console.error("LiveKit call finalization failed.", {
		errorName: error instanceof Error ? error.name : "UnknownError",
	});
}
