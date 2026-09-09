import type { Appointment, AppointmentSlot } from "../models/appointment.js";
import type { BusinessConfig, ServiceId } from "../models/business.js";
import type { Conversation } from "../models/conversation.js";
import type { Customer, Pet } from "../models/customer.js";
import type {
	ConversationOutcome,
	InterpretedMessage,
	ReceptionistIntent,
} from "../models/receptionist.js";

export interface AvailabilityRequest {
	businessId: string;
	serviceId: ServiceId;
	durationMinutes: number;
	searchFrom: string;
	searchUntil: string;
}

export interface AppointmentRequest {
	businessId: string;
	contactPhone: string;
	petName: string;
	serviceId: ServiceId;
	startAt: string;
	endAt: string;
}

export interface Calendar {
	findAvailableSlots(request: AvailabilityRequest): Promise<AppointmentSlot[]>;
	findAppointments(businessId: string, contactPhone: string): Promise<Appointment[]>;
	createAppointment(request: AppointmentRequest): Promise<Appointment>;
	rescheduleAppointment(appointmentId: string, slot: AppointmentSlot): Promise<Appointment>;
	cancelAppointment(appointmentId: string): Promise<void>;
}

export interface ContactRecord {
	businessId: string;
	customer: Customer;
	pets: readonly Pet[];
	notes?: string;
	lastContactAt: string;
}

export interface Contacts {
	findByContactPhone(
		businessId: string,
		contactPhone: string,
	): Promise<ContactRecord | undefined>;
	save(contact: ContactRecord): Promise<void>;
}

export interface CallLogEntry {
	businessId: string;
	conversationId: string;
	intent: ReceptionistIntent;
	callerPhone?: string;
	contactPhone?: string;
	outcome: ConversationOutcome;
	endedAt: string;
}

export interface CallLog {
	append(entry: CallLogEntry): Promise<void>;
}

export interface MessageInterpreter {
	interpret(
		message: string,
		business: BusinessConfig,
		conversation: Conversation,
	): Promise<InterpretedMessage>;
}
