import assert from "node:assert/strict";
import { test } from "node:test";

import { findBusinessConfig } from "../../src/config/constants.js";
import { Appointment } from "../../src/models/appointment.js";
import { Conversation } from "../../src/models/conversation.js";
import type {
	AppointmentBookingRequest,
	AppointmentBookingService,
} from "../../src/services/appointment-booking.js";
import { BusinessInformationService } from "../../src/services/business-information.js";
import {
	ConversationOrchestrator,
	type ConversationOrchestratorDependencies,
} from "../../src/services/conversation-orchestrator.js";
import type { MessageInterpreter } from "../../src/services/receptionist-dependencies.js";
import type { InterpretedMessage } from "../../src/models/receptionist.js";

const business = findBusinessConfig("maple-street-dog-grooming");

if (!business) {
	throw new Error("Expected Maple Street business configuration in test setup");
}

const configuredBusiness = business;

class FakeInterpreter implements MessageInterpreter {
	constructor(private readonly result: InterpretedMessage | Error) {}

	async interpret(): Promise<InterpretedMessage> {
		if (this.result instanceof Error) throw this.result;
		return this.result;
	}
}

function createDependencies(
	booking: Pick<AppointmentBookingService, "book"> = {
		async book(): Promise<Appointment> {
			return new Appointment({
				id: "appointment-orchestrated-1",
				businessId: configuredBusiness.id,
				contactPhone: "+14155550100",
				petName: "Milo",
				serviceId: "bath",
				startAt: "2026-09-12T17:00:00.000Z",
				endAt: "2026-09-12T18:00:00.000Z",
			});
		},
	},
): ConversationOrchestratorDependencies {
	return {
		information: new BusinessInformationService(configuredBusiness),
		booking,
		management: {
			async findAppointments() {
				return { status: "not_found", appointments: [] };
			},
			async reschedule() {
				throw new Error("Not used in this test");
			},
			async cancel() {
				throw new Error("Not used in this test");
			},
		},
		support: {
			async handleLateArrival() {
				throw new Error("Not used in this test");
			},
			async recordComplaint() {
				throw new Error("Not used in this test");
			},
		},
	};
}

function createConversation(): Conversation {
	const conversation = new Conversation({
		id: "conversation-orchestrator-1",
		businessId: configuredBusiness.id,
	});
	conversation.addMessage("customer", "What time do you open?");
	return conversation;
}

test("routes interpreted informational requests to deterministic business logic", async () => {
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter({ intent: "business_hours" }),
		createDependencies(),
	);
	const conversation = createConversation();

	const result = await orchestrator.handleMessage("What time do you open?", conversation);

	assert.equal(result.outcome.status, "answered");
	assert.match(result.reply, /9:00 AM to 5:00 PM/);
	assert.equal(conversation.messages.at(-1)?.author, "receptionist");
});

test("handles interpreter failure without calling an application service", async () => {
	let bookingCalled = false;
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter(new Error("malformed model output")),
		createDependencies({
			async book(): Promise<Appointment> {
				bookingCalled = true;
				throw new Error("Should not be called");
			},
		}),
	);
	const conversation = createConversation();

	const result = await orchestrator.handleMessage("Book it", conversation);

	assert.equal(result.outcome.status, "needs_information");
	assert.match(result.reply, /rephrase/);
	assert.equal(bookingCalled, false);
});

test("does not write a booking before explicit confirmation", async () => {
	let bookingCalled = false;
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter({
			intent: "book_appointment",
			customerName: "Alex Morgan",
			contactPhone: "+14155550100",
			contactPhoneConfirmed: true,
			petName: "Milo",
			weightLb: 25,
			rabiesVaccinationStatus: "current",
			serviceId: "bath",
			requestedDate: "2026-09-12",
			requestedTime: "10:00",
		}),
		createDependencies({
			async book(): Promise<Appointment> {
				bookingCalled = true;
				throw new Error("Should not be called");
			},
		}),
	);
	const conversation = createConversation();

	const result = await orchestrator.handleMessage("Book a bath for Milo", conversation);

	assert.equal(result.outcome.status, "needs_information");
	assert.match(result.reply, /confirm/);
	assert.equal(bookingCalled, false);
});

test("passes confirmed booking details to the booking service", async () => {
	let receivedRequest: AppointmentBookingRequest | undefined;
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter({
			intent: "book_appointment",
			customerName: "Alex Morgan",
			contactPhone: "+14155550100",
			contactPhoneConfirmed: true,
			petName: "Milo",
			weightLb: 25,
			rabiesVaccinationStatus: "current",
			serviceId: "bath",
			requestedDate: "2026-09-12",
			requestedTime: "10:00",
			confirmation: true,
		}),
		createDependencies({
			async book(request: AppointmentBookingRequest): Promise<Appointment> {
				receivedRequest = request;
				return new Appointment({
					id: "appointment-orchestrated-2",
					businessId: configuredBusiness.id,
					contactPhone: request.contactPhone,
					petName: request.pet.name,
					serviceId: request.serviceId,
					startAt: request.startAt,
					endAt: request.endAt,
				});
			},
		}),
	);
	const conversation = createConversation();

	const result = await orchestrator.handleMessage("Book it", conversation);

	assert.equal(result.outcome.status, "completed");
	assert.equal(receivedRequest?.contactPhone, "+14155550100");
	assert.equal(receivedRequest?.pet.name, "Milo");
	assert.equal(receivedRequest?.startAt, "2026-09-12T17:00:00.000Z");
	assert.equal(receivedRequest?.endAt, "2026-09-12T18:00:00.000Z");
});
