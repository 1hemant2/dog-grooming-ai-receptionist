import type { ServiceId } from "./business.js";

export type ReceptionistIntent =
	| "services"
	| "pricing"
	| "business_hours"
	| "breed_or_size"
	| "vaccination"
	| "book_appointment"
	| "reschedule_appointment"
	| "cancel_appointment"
	| "running_late"
	| "complaint"
	| "unknown";

export type ConversationOutcomeStatus =
	"answered" | "needs_information" | "completed" | "unavailable" | "needs_human";

// conversation must have some outcome
export interface ConversationOutcome {
	status: ConversationOutcomeStatus;
	summary: string;
	appointmentId?: string;
	callbackRequested: boolean;
}

// This will be goint to use recptionist business logic, we will get this from message MessageInterpreter
export interface InterpretedMessage {
	intent: ReceptionistIntent;
	customerName?: string;
	contactPhone?: string;
	petName?: string;
	breedOrMix?: string;
	weightLb?: number;
	serviceId?: ServiceId;
	requestedDate?: string;
	requestedTime?: string;
	minutesLate?: number;
	confirmation?: boolean;
}

export function createConversationOutcome(
	status: ConversationOutcomeStatus,
	summary: string,
	appointmentId?: string,
): ConversationOutcome {
	const normalizedSummary = summary.trim();

	if (normalizedSummary.length === 0) {
		throw new InvalidConversationOutcomeError("Outcome summary is required");
	}

	const outcome: ConversationOutcome = {
		status,
		summary: normalizedSummary,
		callbackRequested: status === "needs_human",
	};

	if (appointmentId) {
		outcome.appointmentId = appointmentId;
	}

	return outcome;
}

export class InvalidConversationOutcomeError extends Error {}
