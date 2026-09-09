import assert from "node:assert/strict";
import { test } from "node:test";

import { findBusinessConfig } from "../../src/config/constants.js";
import { Appointment, AppointmentSlot } from "../../src/models/appointment.js";
import { Customer, Pet } from "../../src/models/customer.js";
import {
	AppointmentCalendarError,
	AppointmentChangeConfirmationRequiredError,
	AppointmentManagementService,
	AppointmentNeedsHumanReviewError,
	AppointmentUnavailableError,
	type RescheduleAppointmentRequest,
} from "../../src/services/appointment-management.js";
import type {
	AppointmentCalendar,
	AvailabilityRequest,
	AvailabilityResult,
	CallLog,
	CallLogEntry,
	CalendarAvailability,
	ContactRecord,
	Contacts,
	OwnerNotifier,
} from "../../src/services/receptionist-dependencies.js";

const business = findBusinessConfig("maple-street-dog-grooming");

if (!business) {
	throw new Error("Expected Maple Street business configuration in test setup");
}

const configuredBusiness = business;

const contactPhone = "+14155550100";
const callerPhone = "+14155550101";
const now = "2026-09-09T12:00:00.000Z";
const currentAppointmentStart = "2026-09-11T16:00:00.000Z";
const currentAppointmentEnd = "2026-09-11T17:00:00.000Z";
const newAppointmentStart = "2026-09-12T16:00:00.000Z";
const newAppointmentEnd = "2026-09-12T17:00:00.000Z";

class FakeAppointmentCalendar implements AppointmentCalendar {
	appointments: Appointment[] = [];
	readonly findRequests: { businessId: string; contactPhone: string }[] = [];
	readonly rescheduleRequests: { appointmentId: string; slot: AppointmentSlot }[] = [];
	readonly cancelRequests: string[] = [];
	findFailure: Error | undefined;
	rescheduleFailure: Error | undefined;
	cancelFailure: Error | undefined;

	async findAppointments(businessId: string, phone: string): Promise<Appointment[]> {
		this.findRequests.push({ businessId, contactPhone: phone });

		if (this.findFailure) {
			throw this.findFailure;
		}

		return this.appointments.filter((appointment) => appointment.contactPhone === phone);
	}

	async rescheduleAppointment(
		appointmentId: string,
		slot: AppointmentSlot,
	): Promise<Appointment> {
		this.rescheduleRequests.push({ appointmentId, slot });

		if (this.rescheduleFailure) {
			throw this.rescheduleFailure;
		}

		const appointment = this.appointments.find((candidate) => candidate.id === appointmentId);
		if (!appointment) {
			throw new Error("Appointment does not exist");
		}

		appointment.reschedule(slot.startAt, slot.endAt);
		return appointment;
	}

	async cancelAppointment(appointmentId: string): Promise<void> {
		this.cancelRequests.push(appointmentId);

		if (this.cancelFailure) {
			throw this.cancelFailure;
		}

		const appointment = this.appointments.find((candidate) => candidate.id === appointmentId);
		if (!appointment) {
			throw new Error("Appointment does not exist");
		}

		appointment.cancel();
	}
}

class FakeAvailability implements CalendarAvailability {
	readonly requests: AvailabilityRequest[] = [];
	result: AvailabilityResult = {
		status: "available",
		slots: [new AppointmentSlot(newAppointmentStart, newAppointmentEnd)],
	};

	async findAvailableSlots(request: AvailabilityRequest): Promise<AvailabilityResult> {
		this.requests.push(request);
		return this.result;
	}
}

class FakeContacts implements Contacts {
	contact: ContactRecord;
	readonly savedContacts: ContactRecord[] = [];
	findFailure: Error | undefined;
	saveFailure: Error | undefined;

	constructor(contact: ContactRecord) {
		this.contact = contact;
	}

	async findByContactPhone(
		businessId: string,
		phone: string,
	): Promise<ContactRecord | undefined> {
		if (this.findFailure) {
			throw this.findFailure;
		}

		if (
			this.contact.businessId !== businessId ||
			this.contact.customer.contactPhone !== phone
		) {
			return undefined;
		}

		return this.contact;
	}

	async save(contact: ContactRecord): Promise<void> {
		if (this.saveFailure) {
			throw this.saveFailure;
		}

		this.contact = contact;
		this.savedContacts.push(contact);
	}
}

class FakeCallLog implements CallLog {
	readonly entries: CallLogEntry[] = [];

	async append(entry: CallLogEntry): Promise<void> {
		this.entries.push(entry);
	}
}

class FakeOwnerNotifier implements OwnerNotifier {
	readonly messages: string[] = [];
	failure: Error | undefined;

	async notify(message: string): Promise<void> {
		if (this.failure) {
			throw this.failure;
		}

		this.messages.push(message);
	}
}

function createContact(): ContactRecord {
	return {
		businessId: configuredBusiness.id,
		customer: new Customer(contactPhone, "Alex Morgan"),
		pets: [
			new Pet({
				name: "Milo",
				weightLb: 25,
				rabiesVaccinationStatus: "current",
			}),
		],
		lastContactAt: "2026-09-01T12:00:00.000Z",
	};
}

function createAppointment(
	id = "appointment-1",
	startAt = currentAppointmentStart,
	endAt = currentAppointmentEnd,
	petName = "Milo",
): Appointment {
	return new Appointment({
		id,
		businessId: configuredBusiness.id,
		contactPhone,
		petName,
		serviceId: "bath",
		startAt,
		endAt,
	});
}

function createService(): {
	service: AppointmentManagementService;
	calendar: FakeAppointmentCalendar;
	availability: FakeAvailability;
	contacts: FakeContacts;
	callLog: FakeCallLog;
	notifier: FakeOwnerNotifier;
} {
	const calendar = new FakeAppointmentCalendar();
	const availability = new FakeAvailability();
	const contacts = new FakeContacts(createContact());
	const callLog = new FakeCallLog();
	const notifier = new FakeOwnerNotifier();
	const service = new AppointmentManagementService(
		configuredBusiness,
		calendar,
		availability,
		contacts,
		callLog,
		notifier,
		() => new Date(now),
	);

	return { service, calendar, availability, contacts, callLog, notifier };
}

function createRescheduleRequest(
	overrides: Partial<RescheduleAppointmentRequest> = {},
): RescheduleAppointmentRequest {
	return {
		businessId: configuredBusiness.id,
		conversationId: "conversation-management-1",
		callerPhone,
		customerName: "Alex Morgan",
		contactPhone,
		petName: "Milo",
		appointmentId: "appointment-1",
		newStartAt: newAppointmentStart,
		newEndAt: newAppointmentEnd,
		confirmed: true,
		...overrides,
	};
}

test("finds an appointment after confirming the customer and pet", async () => {
	const { service, calendar } = createService();
	calendar.appointments = [
		createAppointment(),
		createAppointment(
			"luna-appointment",
			"2026-09-13T16:00:00.000Z",
			"2026-09-13T17:00:00.000Z",
			"Luna",
		),
	];

	const result = await service.findAppointments({
		businessId: configuredBusiness.id,
		contactPhone,
		customerName: "alex morgan",
		petName: "milo",
	});

	assert.equal(result.status, "found");
	assert.equal(result.appointments[0]?.id, "appointment-1");
	assert.equal(calendar.findRequests.length, 1);
});

test("reports ambiguous appointments for the same pet", async () => {
	const { service, calendar } = createService();
	calendar.appointments = [
		createAppointment(),
		createAppointment("appointment-2", "2026-09-13T16:00:00.000Z", "2026-09-13T17:00:00.000Z"),
	];

	const result = await service.findAppointments({
		businessId: configuredBusiness.id,
		contactPhone,
		customerName: "Alex Morgan",
		petName: "Milo",
	});

	assert.equal(result.status, "ambiguous");
	assert.equal(result.appointments.length, 2);
});

test("reports when no appointment matches the confirmed identity", async () => {
	const { service } = createService();

	const result = await service.findAppointments({
		businessId: configuredBusiness.id,
		contactPhone,
		customerName: "Alex Morgan",
		petName: "Milo",
	});

	assert.equal(result.status, "not_found");
	assert.equal(result.appointments.length, 0);
});

test("reschedules an appointment after a final availability check", async () => {
	const { service, calendar, availability, contacts, callLog, notifier } = createService();
	calendar.appointments = [createAppointment()];

	const updatedAppointment = await service.reschedule(createRescheduleRequest());

	assert.equal(updatedAppointment.startAt, newAppointmentStart);
	assert.equal(availability.requests[0]?.dogWeightLb, 25);
	assert.equal(calendar.rescheduleRequests.length, 1);
	assert.equal(calendar.rescheduleRequests[0]?.appointmentId, "appointment-1");
	assert.equal(contacts.savedContacts.length, 1);
	assert.equal(callLog.entries[0]?.intent, "reschedule_appointment");
	assert.equal(callLog.entries[0]?.outcome.appointmentId, "appointment-1");
	assert.equal(notifier.messages.length, 1);
});

test("does not change an appointment inside the notice window", async () => {
	const { service, calendar, availability, notifier } = createService();
	calendar.appointments = [
		createAppointment("appointment-1", "2026-09-09T20:00:00.000Z", "2026-09-09T21:00:00.000Z"),
	];

	await assert.rejects(
		service.reschedule(createRescheduleRequest()),
		AppointmentNeedsHumanReviewError,
	);

	assert.equal(availability.requests.length, 0);
	assert.equal(calendar.rescheduleRequests.length, 0);
	assert.equal(notifier.messages.length, 0);
});

test("does not change an appointment that has already started", async () => {
	const { service, calendar } = createService();
	calendar.appointments = [
		createAppointment("appointment-1", "2026-09-09T10:00:00.000Z", "2026-09-09T11:00:00.000Z"),
	];

	await assert.rejects(
		service.reschedule(createRescheduleRequest()),
		AppointmentNeedsHumanReviewError,
	);

	assert.equal(calendar.rescheduleRequests.length, 0);
});

test("does not reschedule when the new slot is no longer available", async () => {
	const { service, calendar, availability } = createService();
	calendar.appointments = [createAppointment()];
	availability.result = { status: "unavailable", slots: [], reason: "Slot is occupied" };

	await assert.rejects(
		service.reschedule(createRescheduleRequest()),
		AppointmentUnavailableError,
	);

	assert.equal(calendar.rescheduleRequests.length, 0);
});

test("returns a controlled error when Calendar rescheduling fails", async () => {
	const { service, calendar, notifier, callLog } = createService();
	calendar.appointments = [createAppointment()];
	calendar.rescheduleFailure = new Error("Calendar is unavailable");

	await assert.rejects(service.reschedule(createRescheduleRequest()), AppointmentCalendarError);

	assert.equal(notifier.messages.length, 0);
	assert.equal(callLog.entries.length, 0);
});

test("requires confirmation before cancellation", async () => {
	const { service, calendar } = createService();

	await assert.rejects(
		service.cancel({
			...createRescheduleRequest(),
			confirmed: false,
		}),
		AppointmentChangeConfirmationRequiredError,
	);

	assert.equal(calendar.findRequests.length, 0);
	assert.equal(calendar.cancelRequests.length, 0);
});

test("cancels an appointment, logs it, and notifies the owner", async () => {
	const { service, calendar, contacts, callLog, notifier } = createService();
	calendar.appointments = [createAppointment()];

	await service.cancel(createRescheduleRequest());

	assert.deepEqual(calendar.cancelRequests, ["appointment-1"]);
	assert.equal(contacts.savedContacts.length, 1);
	assert.equal(callLog.entries[0]?.intent, "cancel_appointment");
	assert.equal(callLog.entries[0]?.outcome.appointmentId, "appointment-1");
	assert.equal(notifier.messages.length, 1);
});

test("returns a controlled error when Calendar cancellation fails", async () => {
	const { service, calendar, notifier, callLog } = createService();
	calendar.appointments = [createAppointment()];
	calendar.cancelFailure = new Error("Calendar is unavailable");

	await assert.rejects(service.cancel(createRescheduleRequest()), AppointmentCalendarError);

	assert.equal(notifier.messages.length, 0);
	assert.equal(callLog.entries.length, 0);
});

test("returns a controlled error when Calendar lookup fails", async () => {
	const { service, calendar } = createService();
	calendar.findFailure = new Error("Calendar is unavailable");

	await assert.rejects(
		service.findAppointments({
			businessId: configuredBusiness.id,
			contactPhone,
			customerName: "Alex Morgan",
			petName: "Milo",
		}),
		AppointmentCalendarError,
	);
});
