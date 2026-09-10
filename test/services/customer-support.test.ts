import assert from "node:assert/strict";
import { test } from "node:test";

import { findBusinessConfig } from "../../src/config/constants.js";
import { Appointment } from "../../src/models/appointment.js";
import { Customer, Pet } from "../../src/models/customer.js";
import {
	CustomerSupportIdentityError,
	CustomerSupportNotificationError,
	CustomerSupportPersistenceError,
	CustomerSupportService,
	InvalidCustomerSupportRequestError,
	type ComplaintRequest,
	type LateArrivalRequest,
} from "../../src/services/customer-support.js";
import type {
	CallLog,
	CallLogEntry,
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
const now = "2026-09-10T12:00:00.000Z";
const appointmentStart = "2026-09-12T16:00:00.000Z";
const appointmentEnd = "2026-09-12T17:00:00.000Z";

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
	failure: Error | undefined;

	async append(entry: CallLogEntry): Promise<void> {
		if (this.failure) {
			throw this.failure;
		}

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

function createAppointment(): Appointment {
	return new Appointment({
		id: "appointment-1",
		businessId: configuredBusiness.id,
		contactPhone,
		petName: "Milo",
		serviceId: "bath",
		startAt: appointmentStart,
		endAt: appointmentEnd,
	});
}

function createService(): {
	service: CustomerSupportService;
	contacts: FakeContacts;
	callLog: FakeCallLog;
	notifier: FakeOwnerNotifier;
} {
	const contacts = new FakeContacts(createContact());
	const callLog = new FakeCallLog();
	const notifier = new FakeOwnerNotifier();
	const service = new CustomerSupportService(
		configuredBusiness,
		contacts,
		callLog,
		notifier,
		() => new Date(now),
	);

	return { service, contacts, callLog, notifier };
}

function createLateArrivalRequest(overrides: Partial<LateArrivalRequest> = {}): LateArrivalRequest {
	return {
		businessId: configuredBusiness.id,
		conversationId: "conversation-support-1",
		callerPhone,
		contactPhone,
		customerName: "Alex Morgan",
		petName: "Milo",
		appointment: createAppointment(),
		minutesLate: 10,
		...overrides,
	};
}

function createComplaintRequest(overrides: Partial<ComplaintRequest> = {}): ComplaintRequest {
	return {
		businessId: configuredBusiness.id,
		conversationId: "conversation-support-1",
		callerPhone,
		contactPhone,
		customerName: "Alex Morgan",
		petName: "Milo",
		appointment: createAppointment(),
		category: "other",
		details: "The pickup experience was confusing.",
		...overrides,
	};
}

test("keeps a short delay, records it, and notifies the owner", async () => {
	const { service, contacts, callLog, notifier } = createService();

	const result = await service.handleLateArrival(createLateArrivalRequest());

	assert.equal(result.outcome.status, "completed");
	assert.equal(result.outcome.callbackRequested, false);
	assert.match(result.reply, /kept the appointment/);
	assert.equal(callLog.entries[0]?.intent, "running_late");
	assert.equal(callLog.entries[0]?.outcome.appointmentId, "appointment-1");
	assert.equal(contacts.savedContacts.length, 1);
	assert.match(contacts.savedContacts[0]?.notes ?? "", /10 minutes late/);
	assert.equal(notifier.messages.length, 1);
});

test("hands off a delay at the configured threshold", async () => {
	const { service, callLog, notifier } = createService();

	const result = await service.handleLateArrival(
		createLateArrivalRequest({ minutesLate: configuredBusiness.lateHandoffMinutes }),
	);

	assert.equal(result.outcome.status, "needs_human");
	assert.equal(result.outcome.callbackRequested, true);
	assert.match(result.reply, /call you back/);
	assert.equal(callLog.entries[0]?.outcome.callbackRequested, true);
	assert.equal(notifier.messages.length, 1);
});

test("requires the customer and pet to match the stored contact", async () => {
	const { service, callLog, notifier } = createService();

	await assert.rejects(
		service.handleLateArrival(createLateArrivalRequest({ customerName: "Unknown Customer" })),
		CustomerSupportIdentityError,
	);

	assert.equal(callLog.entries.length, 0);
	assert.equal(notifier.messages.length, 0);
});

test("records a refund complaint without making a refund decision", async () => {
	const { service, callLog, notifier } = createService();

	const result = await service.recordComplaint(
		createComplaintRequest({
			category: "refund_or_charge",
			disputedCharge: "$75 charge",
			details: "I do not recognize this charge.",
		}),
	);

	assert.equal(result.outcome.status, "needs_human");
	assert.match(result.reply, /cannot make refund or charge decisions/);
	assert.match(callLog.entries[0]?.outcome.summary ?? "", /\$75 charge/);
	assert.equal(notifier.messages.length, 1);
});

test("records an ordinary complaint as an owner callback request", async () => {
	const { service, callLog } = createService();
	const request = createComplaintRequest({
		category: "other",
	});
	delete request.appointment;
	delete request.petName;

	const result = await service.recordComplaint(request);

	assert.equal(result.outcome.status, "needs_human");
	assert.equal(result.outcome.callbackRequested, true);
	assert.equal(callLog.entries[0]?.intent, "complaint");
	assert.match(result.reply, /call you back/);
});

test("handles a routine operational complaint without a callback", async () => {
	const { service, callLog, notifier } = createService();

	const result = await service.recordComplaint(
		createComplaintRequest({
			category: "operational",
			resolution: "The appointment confirmation was resent to your phone.",
		}),
	);

	assert.equal(result.outcome.status, "completed");
	assert.equal(result.outcome.callbackRequested, false);
	assert.match(result.reply, /appointment confirmation was resent/);
	assert.match(callLog.entries[0]?.outcome.summary ?? "", /handled this operational concern/);
	assert.equal(notifier.messages.length, 0);
});

test("requires a deterministic resolution for an operational complaint", async () => {
	const { service } = createService();

	await assert.rejects(
		service.recordComplaint(createComplaintRequest({ category: "operational" })),
		InvalidCustomerSupportRequestError,
	);
});

test("notes a possible corrective groom for a recent quality complaint", async () => {
	const { service, contacts } = createService();
	const recentAppointment = new Appointment({
		id: "appointment-recent",
		businessId: configuredBusiness.id,
		contactPhone,
		petName: "Milo",
		serviceId: "bath",
		startAt: "2026-09-09T10:00:00.000Z",
		endAt: "2026-09-09T11:00:00.000Z",
	});

	await service.recordComplaint(
		createComplaintRequest({
			appointment: recentAppointment,
			category: "grooming_quality",
			details: "The coat was still tangled after the appointment.",
		}),
	);

	assert.match(contacts.savedContacts[0]?.notes ?? "", /corrective groom/);
});

test("sends safety complaints for immediate human review", async () => {
	const { service } = createService();

	const result = await service.recordComplaint(
		createComplaintRequest({
			category: "injury",
			details: "My dog was injured during the appointment.",
		}),
	);

	assert.match(result.reply, /immediate review/);
	assert.equal(result.outcome.status, "needs_human");
});

test("requires appointment and charge details for a refund complaint", async () => {
	const { service } = createService();
	const requestWithoutAppointment = createComplaintRequest({
		category: "refund_or_charge",
	});
	delete requestWithoutAppointment.appointment;

	await assert.rejects(
		service.recordComplaint(requestWithoutAppointment),
		InvalidCustomerSupportRequestError,
	);
});

test("returns a controlled error when support persistence fails", async () => {
	const { service, contacts, notifier } = createService();
	contacts.saveFailure = new Error("Sheets unavailable");

	await assert.rejects(
		service.handleLateArrival(createLateArrivalRequest()),
		CustomerSupportPersistenceError,
	);

	assert.equal(notifier.messages.length, 0);
});

test("returns a controlled error when owner notification fails", async () => {
	const { service, callLog, notifier } = createService();
	notifier.failure = new Error("Telegram unavailable");

	await assert.rejects(
		service.handleLateArrival(createLateArrivalRequest()),
		CustomerSupportNotificationError,
	);

	assert.equal(callLog.entries.length, 1);
});
