import type { ServiceId } from "./business.js";
import type { RabiesVaccinationStatus } from "./customer.js";

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

export type ConversationAction = "continue" | "reject_suggested_times" | "require_exact_time";

export type ComplaintCategory =
	| "operational"
	| "refund_or_charge"
	| "grooming_quality"
	| "safety"
	| "injury"
	| "aggressive_behavior"
	| "compensation"
	| "other";

export type ExpectedCustomerField =
	| "contact_phone"
	| "contact_phone_confirmation"
	| "customer_name"
	| "pet_name"
	| "dog_weight"
	| "rabies_status"
	| "service"
	| "requested_date"
	| "requested_time"
	| "appointment_confirmation"
	| "minutes_late"
	| "complaint_category";

// conversation must have some outcome
export interface ConversationOutcome {
	status: ConversationOutcomeStatus;
	summary: string;
	appointmentId?: string;
	callbackRequested: boolean;
}

export interface InterpretedMessage {
	intent: ReceptionistIntent;
	conversationAction?: ConversationAction;
	customerName?: string;
	contactPhone?: string;
	contactPhoneConfirmed?: boolean;
	petName?: string;
	breedOrMix?: string;
	weightLb?: number;
	rabiesVaccinationStatus?: RabiesVaccinationStatus;
	healthConcerns?: string;
	behaviorConcerns?: string;
	safetyConcern?: string;
	serviceId?: ServiceId;
	serviceName?: string;
	requestedServiceNames?: string[];
	dayName?: string;
	requestedDate?: string;
	requestedTime?: string;
	appointmentId?: string;
	minutesLate?: number;
	confirmation?: boolean;
	complaintCategory?: ComplaintCategory;
	complaintDetails?: string;
	disputedCharge?: string;
	resolution?: string;
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
