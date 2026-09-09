import { AppointmentSlot, type Appointment } from "../models/appointment.js";
import type { BusinessConfig, GroomingService, ServiceId } from "../models/business.js";
import { Customer, Pet, isValidPhoneNumber, PetDetails } from "../models/customer.js";
import { createConversationOutcome } from "../models/receptionist.js";
import type {
	AvailabilityResult,
	CallLog,
	CalendarAppointmentWriter,
	CalendarAvailability,
	ContactRecord,
	Contacts,
} from "./receptionist-dependencies.js";

export interface AppointmentBookingRequest {
	businessId: string;
	conversationId: string;
	callerPhone?: string;
	customerName: string;
	contactPhone: string;
	pet: PetDetails;
	serviceId: ServiceId;
	startAt: string;
	endAt: string;
	confirmed: boolean;
	safetyConcern?: string;
}

interface PreparedBooking {
	request: AppointmentBookingRequest;
	customer: Customer;
	pet: Pet;
	service: GroomingService;
	slot: AppointmentSlot;
}

export class AppointmentBookingError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
	}
}

export class InvalidAppointmentBookingError extends AppointmentBookingError {}

export class BookingConfirmationRequiredError extends AppointmentBookingError {}

export class AppointmentUnavailableError extends AppointmentBookingError {}

export class AppointmentNeedsHumanReviewError extends AppointmentBookingError {}

export class CalendarAppointmentError extends AppointmentBookingError {}

export class BookingPersistenceError extends AppointmentBookingError {}

export class AppointmentBookingService {
	private readonly bookingOperations = new Map<string, Promise<Appointment>>();

	constructor(
		private readonly business: BusinessConfig,
		private readonly availability: CalendarAvailability,
		private readonly calendarWriter: CalendarAppointmentWriter,
		private readonly contacts: Contacts,
		private readonly callLog: CallLog,
		private readonly clock: () => Date = () => new Date(),
	) {}

	async book(request: AppointmentBookingRequest): Promise<Appointment> {
		const preparedBooking = this.prepareBooking(request);
		const bookingKey = getBookingKey(preparedBooking);
		const existingOperation = this.bookingOperations.get(bookingKey);

		if (existingOperation) {
			return existingOperation;
		}

		const bookingOperation = this.createBooking(preparedBooking);
		this.bookingOperations.set(bookingKey, bookingOperation);

		return bookingOperation;
	}

	//This validate booking object and return the proper booking object
	private prepareBooking(request: AppointmentBookingRequest): PreparedBooking {
		if (request.businessId !== this.business.id) {
			throw new InvalidAppointmentBookingError(
				"Business does not match the configured calendar",
			);
		}

		if (!request.confirmed) {
			throw new BookingConfirmationRequiredError(
				"Customer confirmation is required before booking",
			);
		}

		if (request.conversationId.trim().length === 0) {
			throw new InvalidAppointmentBookingError("Conversation ID is required");
		}

		if (request.customerName.trim().length === 0) {
			throw new InvalidAppointmentBookingError("Customer name is required");
		}

		if (request.callerPhone !== undefined && !isValidPhoneNumber(request.callerPhone)) {
			throw new InvalidAppointmentBookingError("Caller phone must use E.164 format");
		}

		const customer = new Customer(request.contactPhone, request.customerName);
		const pet = new Pet(request.pet);

		if (this.business.rabiesVaccinationRequired && pet.rabiesVaccinationStatus !== "current") {
			throw new AppointmentNeedsHumanReviewError(
				"Current rabies vaccination proof is required before grooming",
			);
		}

		const service = this.business.services.find(
			(configuredService) => configuredService.id === request.serviceId,
		);

		if (!service) {
			throw new InvalidAppointmentBookingError(
				"Appointment service is not configured for this business",
			);
		}

		return {
			request,
			customer,
			pet,
			service,
			slot: new AppointmentSlot(request.startAt, request.endAt),
		};
	}

	//create the booking and insert the log in contact and call logs
	private async createBooking(booking: PreparedBooking): Promise<Appointment> {
		const availability = await this.availability.findAvailableSlots({
			businessId: booking.request.businessId,
			serviceId: booking.request.serviceId,
			dogWeightLb: booking.pet.weightLb,
			searchFrom: booking.slot.startAt,
			...(booking.request.safetyConcern
				? { safetyConcern: booking.request.safetyConcern }
				: {}),
		});

		ensureRequestedSlotIsAvailable(availability, booking.slot);

		let appointment: Appointment;

		try {
			appointment = await this.calendarWriter.createAppointment({
				businessId: booking.request.businessId,
				customerName: booking.customer.name ?? booking.request.customerName,
				contactPhone: booking.customer.contactPhone,
				petName: booking.pet.name,
				serviceId: booking.request.serviceId,
				startAt: booking.slot.startAt,
				endAt: booking.slot.endAt,
			});
		} catch (error) {
			throw new CalendarAppointmentError("Calendar appointment creation failed", {
				cause: error,
			});
		}

		try {
			const endedAt = this.clock().toISOString();
			const existingContact = await this.contacts.findByContactPhone(
				booking.request.businessId,
				booking.customer.contactPhone,
			);
			const contact = createContactRecord(booking, existingContact, endedAt);

			await this.contacts.save(contact);
			await this.callLog.append({
				businessId: booking.request.businessId,
				conversationId: booking.request.conversationId,
				intent: "book_appointment",
				contactPhone: booking.customer.contactPhone,
				outcome: createConversationOutcome(
					"completed",
					`${booking.service.name} appointment booked for ${booking.pet.name}.`,
					appointment.id,
				),
				endedAt,
				...(booking.request.callerPhone
					? { callerPhone: booking.request.callerPhone }
					: {}),
			});
		} catch (error) {
			throw new BookingPersistenceError(
				"Appointment was created, but contact or Call Log persistence failed",
				{ cause: error },
			);
		}

		return appointment;
	}
}

// This is just varify if request apointment is available or not
function ensureRequestedSlotIsAvailable(
	availability: AvailabilityResult,
	requestedSlot: AppointmentSlot,
): void {
	if (availability.status === "needs_human") {
		throw new AppointmentNeedsHumanReviewError(
			availability.reason ?? "This appointment requires owner review",
		);
	}

	if (availability.status !== "available") {
		throw new AppointmentUnavailableError(
			availability.reason ?? "The requested appointment time is unavailable",
		);
	}

	const requestedStart = Date.parse(requestedSlot.startAt);
	const requestedEnd = Date.parse(requestedSlot.endAt);
	const exactSlotIsAvailable = availability.slots.some(
		(slot) =>
			Date.parse(slot.startAt) === requestedStart && Date.parse(slot.endAt) === requestedEnd,
	);

	if (!exactSlotIsAvailable) {
		throw new AppointmentUnavailableError(
			"The requested appointment time is no longer available",
		);
	}
}

function createContactRecord(
	booking: PreparedBooking,
	existingContact: ContactRecord | undefined,
	lastContactAt: string,
): ContactRecord {
	const contact: ContactRecord = {
		businessId: booking.request.businessId,
		customer: booking.customer,
		pets: mergePets(existingContact?.pets, booking.pet),
		lastContactAt,
	};

	if (existingContact?.notes !== undefined) {
		contact.notes = existingContact.notes;
	}

	return contact;
}

// we are supporting booking for one pet a time,
// but this is for a scenario if client call again for diffrent pet so that we would update in same conact logs instead of dubblicating it.
function mergePets(existingPets: readonly Pet[] | undefined, newPet: Pet): Pet[] {
	const petName = newPet.name.toLowerCase();
	const otherPets = (existingPets ?? []).filter(
		(existingPet) => existingPet.name.toLowerCase() !== petName,
	);

	return [...otherPets, newPet];
}

//make unique booking keys
function getBookingKey(booking: PreparedBooking): string {
	return [
		booking.request.businessId,
		booking.request.conversationId,
		booking.customer.contactPhone,
		booking.pet.name.toLowerCase(),
		booking.request.serviceId,
		Date.parse(booking.slot.startAt),
		Date.parse(booking.slot.endAt),
	].join(":");
}
