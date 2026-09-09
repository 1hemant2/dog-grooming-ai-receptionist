import { AppointmentSlot, type Appointment } from "../models/appointment.js";
import type { BusinessConfig } from "../models/business.js";
import { isValidPhoneNumber, type Pet } from "../models/customer.js";
import { createConversationOutcome } from "../models/receptionist.js";
import type {
	AppointmentCalendar,
	AvailabilityResult,
	CalendarAvailability,
	CallLog,
	ContactRecord,
	Contacts,
	OwnerNotifier,
} from "./receptionist-dependencies.js";

export interface AppointmentIdentity {
	businessId: string;
	contactPhone: string;
	customerName: string;
	petName: string;
}

export type AppointmentLookupRequest = AppointmentIdentity;

interface AppointmentActionRequest extends AppointmentIdentity {
	conversationId: string;
	callerPhone?: string;
	appointmentId: string;
	confirmed: boolean;
}

export interface RescheduleAppointmentRequest extends AppointmentActionRequest {
	newStartAt: string;
	newEndAt: string;
}

export type CancelAppointmentRequest = AppointmentActionRequest;

export type AppointmentLookupStatus = "found" | "not_found" | "ambiguous";

export interface AppointmentLookupResult {
	status: AppointmentLookupStatus;
	appointments: Appointment[];
	reason?: string;
}

interface MatchingAppointments {
	contact: ContactRecord;
	appointments: Appointment[];
}

interface ConfirmedAppointment {
	contact: ContactRecord;
	appointment: Appointment;
	pet: Pet;
}

export class AppointmentManagementError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
	}
}

export class InvalidAppointmentManagementRequestError extends AppointmentManagementError {}

export class AppointmentNotFoundError extends AppointmentManagementError {}

export class AmbiguousAppointmentError extends AppointmentManagementError {}

export class AppointmentNeedsHumanReviewError extends AppointmentManagementError {}

export class AppointmentUnavailableError extends AppointmentManagementError {}

export class AppointmentChangeConfirmationRequiredError extends AppointmentManagementError {}

export class AppointmentCalendarError extends AppointmentManagementError {}

export class AppointmentPersistenceError extends AppointmentManagementError {}

export class OwnerNotificationError extends AppointmentManagementError {}

export class AppointmentManagementService {
	constructor(
		private readonly business: BusinessConfig,
		private readonly appointmentCalendar: AppointmentCalendar,
		private readonly availability: CalendarAvailability,
		private readonly contacts: Contacts,
		private readonly callLog: CallLog,
		private readonly ownerNotifier: OwnerNotifier,
		private readonly clock: () => Date = () => new Date(),
	) {}

	async findAppointments(request: AppointmentLookupRequest): Promise<AppointmentLookupResult> {
		this.validateIdentity(request);
		const matchingAppointments = await this.findMatchingAppointments(request);

		if (!matchingAppointments) {
			return notFound("No matching customer was found.");
		}

		if (matchingAppointments.appointments.length === 0) {
			return notFound("No appointment was found for this pet.");
		}

		if (matchingAppointments.appointments.length > 1) {
			return {
				status: "ambiguous",
				appointments: matchingAppointments.appointments,
				reason: "More than one appointment was found for this pet.",
			};
		}

		return {
			status: "found",
			appointments: matchingAppointments.appointments,
		};
	}

	// find the current appointment and check if requested slot is available and reschedule it.
	async reschedule(request: RescheduleAppointmentRequest): Promise<Appointment> {
		this.validateActionRequest(request);

		if (!request.confirmed) {
			throw new AppointmentChangeConfirmationRequiredError(
				"Customer confirmation is required before rescheduling",
			);
		}

		const newSlot = new AppointmentSlot(request.newStartAt, request.newEndAt);
		const currentAppointment = await this.findConfirmedAppointment(request);
		this.ensureAppointmentCanChange(currentAppointment.appointment);

		const availability = await this.availability.findAvailableSlots({
			businessId: request.businessId,
			serviceId: currentAppointment.appointment.serviceId,
			dogWeightLb: currentAppointment.pet.weightLb,
			searchFrom: newSlot.startAt,
		});
		ensureRequestedSlotIsAvailable(availability, newSlot);

		let updatedAppointment: Appointment;

		try {
			updatedAppointment = await this.appointmentCalendar.rescheduleAppointment(
				currentAppointment.appointment.id,
				newSlot,
			);
		} catch (error) {
			throw new AppointmentCalendarError("Calendar appointment rescheduling failed", {
				cause: error,
			});
		}

		await this.recordSuccessfulChange(
			request,
			currentAppointment.contact,
			updatedAppointment,
			`Appointment rescheduled for ${currentAppointment.pet.name} from ${currentAppointment.appointment.startAt} to ${updatedAppointment.startAt}.`,
			"reschedule_appointment",
		);

		return updatedAppointment;
	}

	async cancel(request: CancelAppointmentRequest): Promise<void> {
		this.validateActionRequest(request);

		if (!request.confirmed) {
			throw new AppointmentChangeConfirmationRequiredError(
				"Customer confirmation is required before cancellation",
			);
		}

		const currentAppointment = await this.findConfirmedAppointment(request);
		this.ensureAppointmentCanChange(currentAppointment.appointment);

		try {
			await this.appointmentCalendar.cancelAppointment(currentAppointment.appointment.id);
		} catch (error) {
			throw new AppointmentCalendarError("Calendar appointment cancellation failed", {
				cause: error,
			});
		}

		await this.recordSuccessfulChange(
			request,
			currentAppointment.contact,
			currentAppointment.appointment,
			`Appointment cancelled for ${currentAppointment.pet.name}.`,
			"cancel_appointment",
		);
	}

	// find all the appointment for a particular client
	private async findMatchingAppointments(
		request: AppointmentIdentity,
	): Promise<MatchingAppointments | undefined> {
		const contact = await this.findConfirmedContact(request);

		if (!contact) {
			return undefined;
		}

		let appointments: Appointment[];

		try {
			appointments = await this.appointmentCalendar.findAppointments(
				request.businessId,
				request.contactPhone,
			);
		} catch (error) {
			throw new AppointmentCalendarError("Calendar appointment lookup failed", {
				cause: error,
			});
		}

		const normalizedPetName = request.petName.trim().toLowerCase();
		const matchingPetAppointments = appointments.filter(
			(appointment) => appointment.petName.trim().toLowerCase() === normalizedPetName,
		);

		return { contact, appointments: matchingPetAppointments };
	}

	private async findConfirmedAppointment(
		request: AppointmentActionRequest,
	): Promise<ConfirmedAppointment> {
		const matchingAppointments = await this.findMatchingAppointments(request);

		if (!matchingAppointments || matchingAppointments.appointments.length === 0) {
			throw new AppointmentNotFoundError("No matching appointment was found");
		}

		if (matchingAppointments.appointments.length > 1) {
			throw new AmbiguousAppointmentError(
				"More than one appointment matches the customer and pet",
			);
		}

		const appointment = matchingAppointments.appointments[0];
		if (!appointment || appointment.id !== request.appointmentId) {
			throw new AppointmentNotFoundError("Appointment does not match the confirmed identity");
		}

		const pet = matchingAppointments.contact.pets.find(
			(existingPet) =>
				existingPet.name.trim().toLowerCase() === request.petName.trim().toLowerCase(),
		);

		if (!pet) {
			throw new AppointmentNotFoundError("Pet details could not be confirmed");
		}

		return { contact: matchingAppointments.contact, appointment, pet };
	}

	private async findConfirmedContact(
		request: AppointmentIdentity,
	): Promise<ContactRecord | undefined> {
		let contact: ContactRecord | undefined;

		try {
			contact = await this.contacts.findByContactPhone(
				request.businessId,
				request.contactPhone,
			);
		} catch (error) {
			throw new AppointmentPersistenceError("Contact lookup failed", { cause: error });
		}

		if (
			!contact ||
			contact.businessId !== this.business.id ||
			!contact.customer.name ||
			contact.customer.name.trim().toLowerCase() !== request.customerName.trim().toLowerCase()
		) {
			return undefined;
		}

		return contact;
	}

	private ensureAppointmentCanChange(appointment: Appointment): void {
		if (appointment.status !== "scheduled") {
			throw new AppointmentNeedsHumanReviewError(
				"This appointment is no longer scheduled and needs owner review",
			);
		}

		const startAt = Date.parse(appointment.startAt);
		const now = this.clock().getTime();

		if (!Number.isFinite(startAt) || startAt <= now) {
			throw new AppointmentNeedsHumanReviewError(
				"This appointment has already started or passed and needs owner review",
			);
		}

		const noticeCutoff = now + this.business.rescheduleNoticeHours * 60 * 60 * 1000;

		//appoint can rescheduled before 24 hours only
		if (startAt < noticeCutoff) {
			throw new AppointmentNeedsHumanReviewError(
				`Changes require at least ${this.business.rescheduleNoticeHours} hours' notice`,
			);
		}
	}

	private async recordSuccessfulChange(
		request: AppointmentActionRequest,
		contact: ContactRecord,
		appointment: Appointment,
		summary: string,
		intent: "reschedule_appointment" | "cancel_appointment",
	): Promise<void> {
		const endedAt = this.clock().toISOString();

		try {
			await this.contacts.save({ ...contact, lastContactAt: endedAt });
			await this.callLog.append({
				businessId: request.businessId,
				conversationId: request.conversationId,
				intent,
				contactPhone: request.contactPhone,
				outcome: createConversationOutcome("completed", summary, appointment.id),
				endedAt,
				...(request.callerPhone ? { callerPhone: request.callerPhone } : {}),
			});
		} catch (error) {
			throw new AppointmentPersistenceError(
				"Calendar changed, but contact or Call Log persistence failed",
				{ cause: error },
			);
		}

		try {
			await this.ownerNotifier.notify(summary);
		} catch (error) {
			throw new OwnerNotificationError(
				"Calendar changed and was logged, but owner notification failed",
				{ cause: error },
			);
		}
	}

	private validateIdentity(request: AppointmentIdentity): void {
		if (request.businessId !== this.business.id) {
			throw new InvalidAppointmentManagementRequestError(
				"Business does not match the configured calendar",
			);
		}

		if (!isValidPhoneNumber(request.contactPhone)) {
			throw new InvalidAppointmentManagementRequestError(
				"Contact phone must use E.164 format",
			);
		}

		if (request.customerName.trim().length === 0 || request.petName.trim().length === 0) {
			throw new InvalidAppointmentManagementRequestError(
				"Customer name and pet name are required",
			);
		}
	}

	private validateActionRequest(request: AppointmentActionRequest): void {
		this.validateIdentity(request);

		if (
			request.conversationId.trim().length === 0 ||
			request.appointmentId.trim().length === 0
		) {
			throw new InvalidAppointmentManagementRequestError(
				"Conversation ID and appointment ID are required",
			);
		}

		if (request.callerPhone !== undefined && !isValidPhoneNumber(request.callerPhone)) {
			throw new InvalidAppointmentManagementRequestError(
				"Caller phone must use E.164 format",
			);
		}
	}
}

function ensureRequestedSlotIsAvailable(
	availability: AvailabilityResult,
	requestedSlot: AppointmentSlot,
): void {
	if (availability.status === "needs_human") {
		throw new AppointmentNeedsHumanReviewError(
			availability.reason ?? "The new appointment time requires owner review",
		);
	}

	if (availability.status !== "available") {
		throw new AppointmentUnavailableError(
			availability.reason ?? "The new appointment time is unavailable",
		);
	}

	const requestedStart = Date.parse(requestedSlot.startAt);
	const requestedEnd = Date.parse(requestedSlot.endAt);
	const exactSlotIsAvailable = availability.slots.some(
		(slot) =>
			Date.parse(slot.startAt) === requestedStart && Date.parse(slot.endAt) === requestedEnd,
	);

	if (!exactSlotIsAvailable) {
		throw new AppointmentUnavailableError("The new appointment time is no longer available");
	}
}

function notFound(reason: string): AppointmentLookupResult {
	return { status: "not_found", appointments: [], reason };
}
