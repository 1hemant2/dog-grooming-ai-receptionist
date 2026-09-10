import assert from "node:assert/strict";
import { test } from "node:test";

import { findBusinessConfig } from "../../src/config/constants.js";
import { Appointment, AppointmentSlot } from "../../src/models/appointment.js";
import type {
	AppointmentRequest,
	AvailabilityRequest,
	AvailabilityResult,
	CalendarAppointmentWriter,
	CalendarAvailability,
	ContactRecord,
	Contacts,
} from "../../src/services/receptionist-dependencies.js";
import {
	AppointmentBookingService,
	AppointmentNeedsHumanReviewError,
	AppointmentUnavailableError,
	BookingConfirmationRequiredError,
	BookingPersistenceError,
	CalendarAppointmentError,
	type AppointmentBookingRequest,
} from "../../src/services/appointment-booking.js";

const business = findBusinessConfig("maple-street-dog-grooming");

if (!business) {
	throw new Error("Expected Maple Street business configuration in test setup");
}

const bookingRequest: AppointmentBookingRequest = {
	businessId: business.id,
	conversationId: "conversation-booking-1",
	callerPhone: "+14155550101",
	customerName: "Alex Morgan",
	contactPhone: "+14155550100",
	pet: {
		name: "Milo",
		breedOrMix: "Poodle mix",
		weightLb: 25,
		rabiesVaccinationStatus: "current",
	},
	serviceId: "bath",
	startAt: "2026-09-10T16:00:00.000Z",
	endAt: "2026-09-10T17:00:00.000Z",
	confirmed: true,
};

class FakeCalendarAvailability implements CalendarAvailability {
	readonly requests: AvailabilityRequest[] = [];
	result: AvailabilityResult = {
		status: "available",
		slots: [new AppointmentSlot(bookingRequest.startAt, bookingRequest.endAt)],
	};

	async findAvailableSlots(request: AvailabilityRequest): Promise<AvailabilityResult> {
		this.requests.push(request);
		return this.result;
	}
}

class FakeCalendarWriter implements CalendarAppointmentWriter {
	readonly requests: AppointmentRequest[] = [];
	appointmentFailure: Error | undefined;

	async createAppointment(request: AppointmentRequest): Promise<Appointment> {
		this.requests.push(request);

		if (this.appointmentFailure) {
			throw this.appointmentFailure;
		}

		return new Appointment({
			id: "appointment-1",
			businessId: request.businessId,
			contactPhone: request.contactPhone,
			petName: request.petName,
			serviceId: request.serviceId,
			startAt: request.startAt,
			endAt: request.endAt,
		});
	}
}

class FakeContacts implements Contacts {
	existingContact: ContactRecord | undefined;
	readonly savedContacts: ContactRecord[] = [];
	saveFailure: Error | undefined;

	async findByContactPhone(
		businessId: string,
		contactPhone: string,
	): Promise<ContactRecord | undefined> {
		if (
			this.existingContact &&
			(this.existingContact.businessId !== businessId ||
				this.existingContact.customer.contactPhone !== contactPhone)
		) {
			return undefined;
		}

		return this.existingContact;
	}

	async save(contact: ContactRecord): Promise<void> {
		if (this.saveFailure) {
			throw this.saveFailure;
		}

		this.savedContacts.push(contact);
	}
}

function createBookingService(): {
	service: AppointmentBookingService;
	availability: FakeCalendarAvailability;
	calendarWriter: FakeCalendarWriter;
	contacts: FakeContacts;
} {
	if (!business) {
		throw new Error("Expected Maple Street business configuration in test setup");
	}

	const availability = new FakeCalendarAvailability();
	const calendarWriter = new FakeCalendarWriter();
	const contacts = new FakeContacts();
	const service = new AppointmentBookingService(
		business,
		availability,
		calendarWriter,
		contacts,
		() => new Date("2026-09-09T12:00:00.000Z"),
	);

	return { service, availability, calendarWriter, contacts };
}

test("books after final availability check and persists the result", async () => {
	const { service, availability, calendarWriter, contacts } = createBookingService();

	const appointment = await service.book(bookingRequest);

	assert.equal(availability.requests.length, 1);
	assert.equal(availability.requests[0]?.dogWeightLb, 25);
	assert.equal(calendarWriter.requests.length, 1);
	assert.equal(calendarWriter.requests[0]?.customerName, "Alex Morgan");
	assert.equal(contacts.savedContacts.length, 1);
	assert.equal(contacts.savedContacts[0]?.pets[0]?.name, "Milo");
	assert.equal(appointment.id, "appointment-1");
});

test("does not write before customer confirmation", async () => {
	const { service, availability, calendarWriter, contacts } = createBookingService();

	await assert.rejects(
		service.book({ ...bookingRequest, confirmed: false }),
		BookingConfirmationRequiredError,
	);

	assert.equal(availability.requests.length, 0);
	assert.equal(calendarWriter.requests.length, 0);
	assert.equal(contacts.savedContacts.length, 0);
});

test("does not create an appointment when the final availability check finds a conflict", async () => {
	const { service, availability, calendarWriter, contacts } = createBookingService();
	availability.result = {
		status: "available",
		slots: [new AppointmentSlot("2026-09-10T16:30:00.000Z", "2026-09-10T17:30:00.000Z")],
	};

	await assert.rejects(service.book(bookingRequest), AppointmentUnavailableError);

	assert.equal(calendarWriter.requests.length, 0);
	assert.equal(contacts.savedContacts.length, 0);
});

test("does not create an appointment when availability requires human review", async () => {
	const { service, availability, calendarWriter } = createBookingService();
	availability.result = {
		status: "needs_human",
		slots: [],
		reason: "Safety-sensitive concerns require owner review before scheduling.",
	};

	await assert.rejects(service.book(bookingRequest), AppointmentNeedsHumanReviewError);

	assert.equal(calendarWriter.requests.length, 0);
});

test("does not create an appointment without current rabies vaccination status", async () => {
	const { service, availability, calendarWriter } = createBookingService();

	await assert.rejects(
		service.book({
			...bookingRequest,
			pet: { ...bookingRequest.pet, rabiesVaccinationStatus: "unknown" },
		}),
		AppointmentNeedsHumanReviewError,
	);

	assert.equal(availability.requests.length, 0);
	assert.equal(calendarWriter.requests.length, 0);
});

test("returns a controlled error when Calendar creation fails", async () => {
	const { service, calendarWriter, contacts } = createBookingService();
	calendarWriter.appointmentFailure = new Error("Calendar is unavailable");

	await assert.rejects(service.book(bookingRequest), CalendarAppointmentError);

	assert.equal(contacts.savedContacts.length, 0);
});

test("creates one Calendar appointment for duplicate submissions", async () => {
	const { service, availability, calendarWriter, contacts } = createBookingService();

	const firstBooking = service.book(bookingRequest);
	const duplicateBooking = service.book(bookingRequest);
	const [firstAppointment, secondAppointment] = await Promise.all([
		firstBooking,
		duplicateBooking,
	]);

	assert.equal(firstAppointment.id, secondAppointment.id);
	assert.equal(availability.requests.length, 1);
	assert.equal(calendarWriter.requests.length, 1);
	assert.equal(contacts.savedContacts.length, 1);
});

test("does not create a second Calendar appointment after persistence fails", async () => {
	const { service, calendarWriter, contacts } = createBookingService();
	contacts.saveFailure = new Error("Sheets is unavailable");

	await assert.rejects(service.book(bookingRequest), (error: unknown) => {
		assert.ok(error instanceof BookingPersistenceError);
		assert.equal(error.appointmentId, "appointment-1");
		return true;
	});
	await assert.rejects(service.book(bookingRequest), BookingPersistenceError);

	assert.equal(calendarWriter.requests.length, 1);
});
