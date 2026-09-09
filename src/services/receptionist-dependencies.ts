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
	dogWeightLb: number;
	searchFrom: string;
	safetyConcern?: string;
}

export type AvailabilityStatus = "available" | "unavailable" | "needs_human";

export interface AvailabilityResult {
	status: AvailabilityStatus;
	slots: AppointmentSlot[];
	reason?: string;
}

export interface CalendarEventRequest {
	businessId: string;
	timeMin: string;
	timeMax: string;
}

export interface CalendarEvent {
	id: string;
	startAt: string;
	endAt: string;
}

export interface CalendarEventSource {
	findEvents(request: CalendarEventRequest): Promise<readonly CalendarEvent[]>;
}

export interface CalendarAvailability {
	findAvailableSlots(request: AvailabilityRequest): Promise<AvailabilityResult>;
}

export interface AppointmentRequest {
	businessId: string;
	customerName: string;
	contactPhone: string;
	petName: string;
	serviceId: ServiceId;
	startAt: string;
	endAt: string;
}

export interface CalendarAppointmentWriter {
	createAppointment(request: AppointmentRequest): Promise<Appointment>;
}

export interface AppointmentCalendar {
	findAppointments(businessId: string, contactPhone: string): Promise<Appointment[]>;
	rescheduleAppointment(appointmentId: string, slot: AppointmentSlot): Promise<Appointment>;
	cancelAppointment(appointmentId: string): Promise<void>;
}

export interface OwnerNotifier {
	notify(message: string): Promise<void>;
}

export interface Calendar
	extends CalendarAvailability, CalendarAppointmentWriter, AppointmentCalendar {}

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
