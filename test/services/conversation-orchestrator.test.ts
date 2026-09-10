import assert from "node:assert/strict";
import { test } from "node:test";

import { findBusinessConfig } from "../../src/config/constants.js";
import { Appointment, AppointmentSlot } from "../../src/models/appointment.js";
import { Conversation } from "../../src/models/conversation.js";
import {
	type AppointmentBookingRequest,
	type AppointmentBookingService,
	BookingPersistenceError,
} from "../../src/services/appointment-booking.js";
import { BusinessInformationService } from "../../src/services/business-information.js";
import {
	ConversationOrchestrator,
	type ConversationOrchestratorDependencies,
} from "../../src/services/conversation-orchestrator.js";
import { getAppointmentDuration } from "../../src/services/calendar-availability.js";
import {
	GeminiMessageInterpreter,
	type GeminiContentClient,
} from "../../src/services/gemini-message-interpreter.js";
import type {
	AvailabilityRequest,
	AvailabilityResult,
	CallLog,
	CallLogEntry,
	CalendarAvailability,
	ContactRecord,
	Contacts,
	MessageInterpreter,
	OwnerNotifier,
} from "../../src/services/receptionist-dependencies.js";
import {
	createConversationOutcome,
	type InterpretedMessage,
} from "../../src/models/receptionist.js";

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

class SequenceInterpreter implements MessageInterpreter {
	constructor(private readonly results: InterpretedMessage[]) {}

	async interpret(): Promise<InterpretedMessage> {
		const result = this.results.shift();
		if (!result) throw new Error("No interpretation configured for this message");
		return result;
	}
}

class OneResponseGeminiClient implements GeminiContentClient {
	callCount = 0;

	constructor(
		private readonly response: InterpretedMessage = {
			intent: "book_appointment",
			serviceId: "full-groom",
		},
	) {}

	models = {
		generateContent: async (): Promise<{ text: string }> => {
			this.callCount += 1;
			return {
				text: JSON.stringify(this.response),
			};
		},
	};
}

class FakeCallLog implements CallLog {
	readonly entries: CallLogEntry[] = [];

	async append(entry: CallLogEntry): Promise<void> {
		this.entries.push(entry);
	}
}

class FakeOwnerNotifier implements OwnerNotifier {
	readonly notifications: string[] = [];

	async notify(message: string): Promise<void> {
		this.notifications.push(message);
	}
}

class FakeContacts implements Contacts {
	readonly savedContacts: ContactRecord[] = [];

	async findByContactPhone(): Promise<ContactRecord | undefined> {
		return undefined;
	}

	async save(contact: ContactRecord): Promise<void> {
		this.savedContacts.push(contact);
	}
}

function createAlwaysAvailable(): CalendarAvailability {
	return {
		async findAvailableSlots(request: AvailabilityRequest): Promise<AvailabilityResult> {
			const service = configuredBusiness.services.find(
				(configuredService) => configuredService.id === request.serviceId,
			);
			const durationMinutes = getAppointmentDuration(
				configuredBusiness,
				service?.durationMinutes ?? 60,
				request.dogWeightLb,
			);
			const searchStart = Date.parse(request.searchFrom);
			const slots: AppointmentSlot[] = [];

			for (let offsetMinutes = 0; offsetMinutes <= 7 * 60; offsetMinutes += 30) {
				const startAt = new Date(searchStart + offsetMinutes * 60_000);
				const endAt = new Date(startAt.getTime() + durationMinutes * 60_000);
				slots.push(new AppointmentSlot(startAt.toISOString(), endAt.toISOString()));
			}

			return { status: "available", slots };
		},
	};
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
	callLog: CallLog = new FakeCallLog(),
	ownerNotifier: OwnerNotifier = new FakeOwnerNotifier(),
	contacts: Contacts = new FakeContacts(),
	availability: CalendarAvailability = createAlwaysAvailable(),
): ConversationOrchestratorDependencies {
	return {
		callLog,
		information: new BusinessInformationService(configuredBusiness),
		booking,
		availability,
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
		ownerNotifier,
		contacts,
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

test("writes one final Call Log entry when the conversation ends", async () => {
	const callLog = new FakeCallLog();
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter({ intent: "business_hours" }),
		createDependencies(undefined, callLog),
	);
	const conversation = createConversation();

	await orchestrator.handleMessage("What time do you open?", conversation);
	await orchestrator.endConversation(conversation);

	assert.equal(callLog.entries.length, 1);
	assert.equal(callLog.entries[0]?.conversationId, conversation.id);
	assert.deepEqual(callLog.entries[0]?.intents, ["business_hours"]);
	assert.equal(callLog.entries[0]?.outcome.status, "answered");
	assert.match(
		callLog.entries[0]?.outcome.summary ?? "",
		/^Handled a business hours request\. Outcome:/,
	);
});

test("writes all distinct conversation intents in their first-seen order", async () => {
	const callLog = new FakeCallLog();
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter({ intent: "business_hours" }),
		createDependencies(undefined, callLog),
	);
	const conversation = createConversation();
	conversation.recordIntent("pricing");
	conversation.recordIntent("book_appointment");
	conversation.recordIntent("complaint");
	conversation.recordIntent("pricing");

	await orchestrator.endConversation(conversation);

	assert.deepEqual(callLog.entries[0]?.intents, ["pricing", "book_appointment", "complaint"]);
	assert.match(
		callLog.entries[0]?.outcome.summary ?? "",
		/^Handled pricing, appointment booking, and complaint requests\. Outcome:/,
	);
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

test("resets an active request locally without calling the interpreter", async () => {
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter(new Error("The interpreter should not be called for reset")),
		createDependencies(),
	);
	const conversation = createConversation();
	conversation.confirmContactPhone("+14155550100");
	conversation.updateActiveRequest({
		intent: "book_appointment",
		petName: "Milo",
		serviceId: "bath",
	});
	conversation.recordOutcome(
		createConversationOutcome("needs_information", "What day works best for Milo?"),
	);
	conversation.expectCustomerField("requested_date");

	const result = await orchestrator.handleMessage("I want to reset in between", conversation);

	assert.equal(result.outcome.status, "needs_information");
	assert.match(result.reply, /cleared the current request/);
	assert.equal(conversation.activeRequest, undefined);
	assert.equal(conversation.expectedCustomerField, undefined);
	assert.equal(conversation.contactPhone, "+14155550100");
});

test("asks for a new date when Gemini classifies rejection of all alternate slots", async () => {
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter({
			intent: "book_appointment",
			conversationAction: "reject_suggested_times",
		}),
		createDependencies(),
	);
	const conversation = createConversation();
	conversation.updateActiveRequest({
		intent: "book_appointment",
		petName: "Nai",
		serviceId: "bath",
		requestedDate: "2026-09-11",
		requestedTime: "15:00",
	});
	conversation.recordOutcome(
		createConversationOutcome("needs_information", "Which alternate time works?"),
	);
	conversation.expectCustomerField("requested_time");
	conversation.markAlternativeSlotsOffered();

	const result = await orchestrator.handleMessage("noone", conversation);

	assert.equal(result.outcome.status, "needs_information");
	assert.equal(result.reply, "No problem. What other date or time would work for you?");
	assert.equal(conversation.activeRequest?.requestedDate, undefined);
	assert.equal(conversation.activeRequest?.requestedTime, undefined);
	assert.equal(conversation.expectedCustomerField, "requested_date");
	assert.equal(conversation.alternativeSlotsOffered, false);
	assert.equal(conversation.alternativeSlotsRejected, true);
});

test("sends an unavailable exact-time-only request to the owner without repeating slots", async () => {
	let bookingCalled = false;
	const ownerNotifier = new FakeOwnerNotifier();
	const availability: CalendarAvailability = {
		async findAvailableSlots(): Promise<AvailabilityResult> {
			return {
				status: "available",
				slots: [
					new AppointmentSlot("2026-09-12T21:00:00.000Z", "2026-09-12T22:00:00.000Z"),
				],
			};
		},
	};
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter({
			intent: "book_appointment",
			conversationAction: "require_exact_time",
			requestedDate: "2026-09-12",
			requestedTime: "15:00",
		}),
		createDependencies(
			{
				async book(): Promise<Appointment> {
					bookingCalled = true;
					throw new Error("Should not be called");
				},
			},
			undefined,
			ownerNotifier,
			undefined,
			availability,
		),
		() => new Date("2026-09-10T12:00:00.000Z"),
	);
	const conversation = createConversation();
	conversation.confirmContactPhone("+14155550100");
	conversation.updateActiveRequest({
		intent: "book_appointment",
		customerName: "Alex Morgan",
		petName: "Rani",
		weightLb: 25,
		rabiesVaccinationStatus: "current",
		serviceId: "bath",
	});
	conversation.recordOutcome(
		createConversationOutcome("needs_information", "What other date or time works?"),
	);
	conversation.expectCustomerField("requested_date");
	conversation.markAlternativeSlotsRejected();

	const result = await orchestrator.handleMessage(
		"Only 3 PM tomorrow will work for me",
		conversation,
	);

	assert.equal(result.outcome.status, "needs_human");
	assert.match(result.reply, /sent your booking request to the owner/i);
	assert.doesNotMatch(result.reply, /customer said|no alternative time/i);
	assert.equal(ownerNotifier.notifications.length, 1);
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

test("offers alternate appointment times before asking for owner review", async () => {
	let bookingCalled = false;
	let availabilityCallCount = 0;
	const availability: CalendarAvailability = {
		async findAvailableSlots(): Promise<AvailabilityResult> {
			availabilityCallCount += 1;

			if (availabilityCallCount === 1) {
				return {
					status: "available",
					slots: [
						new AppointmentSlot("2026-09-12T21:00:00.000Z", "2026-09-12T22:00:00.000Z"),
						new AppointmentSlot("2026-09-12T23:00:00.000Z", "2026-09-13T00:00:00.000Z"),
					],
				};
			}

			return {
				status: "available",
				slots: [
					new AppointmentSlot("2026-09-12T21:00:00.000Z", "2026-09-12T22:00:00.000Z"),
				],
			};
		},
	};
	const interpreter = new SequenceInterpreter([
		{
			intent: "book_appointment",
			customerName: "Alex Morgan",
			contactPhone: "+14155550100",
			contactPhoneConfirmed: true,
			petName: "Milo",
			weightLb: 25,
			rabiesVaccinationStatus: "current",
			serviceId: "bath",
			requestedDate: "2026-09-12",
			requestedTime: "15:00",
		},
		{
			intent: "book_appointment",
			requestedDate: "2026-09-12",
			requestedTime: "14:00",
		},
		{
			intent: "book_appointment",
			confirmation: true,
		},
	]);
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		interpreter,
		createDependencies(
			{
				async book(): Promise<Appointment> {
					bookingCalled = true;
					return new Appointment({
						id: "appointment-alternate-time",
						businessId: configuredBusiness.id,
						contactPhone: "+14155550100",
						petName: "Milo",
						serviceId: "bath",
						startAt: "2026-09-12T21:00:00.000Z",
						endAt: "2026-09-12T22:00:00.000Z",
					});
				},
			},
			undefined,
			undefined,
			undefined,
			availability,
		),
	);
	const conversation = createConversation();

	const alternativeResponse = await orchestrator.handleMessage("Book it at 3 PM", conversation);
	assert.equal(conversation.expectedCustomerField, "requested_time");
	const confirmationResponse = await orchestrator.handleMessage("2 PM works", conversation);
	const completedResponse = await orchestrator.handleMessage("Yes", conversation);

	assert.equal(alternativeResponse.outcome.status, "needs_information");
	assert.match(alternativeResponse.reply, /3:00 PM PDT is not available/);
	assert.match(alternativeResponse.reply, /2:00 PM PDT/);
	assert.match(alternativeResponse.reply, /4:00 PM PDT/);
	assert.match(confirmationResponse.reply, /confirm/);
	assert.equal(completedResponse.outcome.status, "completed");
	assert.equal(bookingCalled, true);
	assert.equal(conversation.ownerHandoffNotified, false);
});

test("notifies the owner when no alternate appointment time exists", async () => {
	let bookingCalled = false;
	const ownerNotifier = new FakeOwnerNotifier();
	const contacts = new FakeContacts();
	const availability: CalendarAvailability = {
		async findAvailableSlots(): Promise<AvailabilityResult> {
			return {
				status: "unavailable",
				slots: [],
				reason: "No suitable appointment slots were found in the search window.",
			};
		},
	};
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
			requestedTime: "15:00",
			confirmation: true,
		}),
		createDependencies(
			{
				async book(): Promise<Appointment> {
					bookingCalled = true;
					throw new Error("Should not be called");
				},
			},
			undefined,
			ownerNotifier,
			contacts,
			availability,
		),
	);

	const response = await orchestrator.handleMessage("Book it at 3 PM", createConversation());

	assert.equal(response.outcome.status, "needs_human");
	assert.match(response.reply, /sent your booking request to the owner/);
	assert.equal(ownerNotifier.notifications.length, 1);
	assert.match(ownerNotifier.notifications[0] ?? "", /3:00 PM PDT/);
	assert.match(ownerNotifier.notifications[0] ?? "", /No suitable appointment slots/);
	assert.equal(bookingCalled, false);
	assert.equal(contacts.savedContacts.length, 1);
});

test("asks for one missing booking detail at a time", async () => {
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter({
			intent: "book_appointment",
			customerName: "Alex Morgan",
			contactPhone: "+14155550100",
			contactPhoneConfirmed: true,
		}),
		createDependencies(),
	);
	const conversation = createConversation();

	const result = await orchestrator.handleMessage("Book an appointment", conversation);

	assert.equal(result.outcome.status, "needs_information");
	assert.equal(result.reply, "And what is your dog's name?");
	assert.equal(conversation.expectedCustomerField, "pet_name");
});

test("offers service choices using customer-friendly language", async () => {
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
		}),
		createDependencies(),
	);

	const result = await orchestrator.handleMessage("Book an appointment", createConversation());

	assert.equal(
		result.reply,
		"Which service would you like for Milo? We offer Bath, Bath and Trim, or Full Groom.",
	);
});

test("preserves booking facts across short follow-up answers", async () => {
	const interpreter = new SequenceInterpreter([
		{
			intent: "book_appointment",
			contactPhone: "+14155550100",
		},
		{
			intent: "book_appointment",
			contactPhoneConfirmed: true,
		},
		{
			intent: "book_appointment",
			customerName: "Hemant Kumar",
		},
	]);
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		interpreter,
		createDependencies(),
	);
	const conversation = createConversation();

	const phoneResponse = await orchestrator.handleMessage("415-555-0100", conversation);
	const confirmationResponse = await orchestrator.handleMessage("Yes", conversation);
	const nameResponse = await orchestrator.handleMessage("Hemant Kumar", conversation);

	assert.match(phoneResponse.reply, /best number/);
	assert.equal(confirmationResponse.reply, "What name should I put on the appointment?");
	assert.equal(nameResponse.reply, "And what is your dog's name?");
	assert.equal(conversation.contactPhone, "+14155550100");
	assert.equal(conversation.activeRequest?.customerName, "Hemant Kumar");
});

test("completes booking follow-ups locally after the initial Gemini interpretation", async () => {
	const geminiClient = new OneResponseGeminiClient();
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		geminiClient,
		() => new Date("2026-09-10T12:00:00.000Z"),
	);
	let bookingRequest: AppointmentBookingRequest | undefined;
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		interpreter,
		createDependencies({
			async book(request: AppointmentBookingRequest): Promise<Appointment> {
				bookingRequest = request;
				return new Appointment({
					id: "appointment-local-follow-ups",
					businessId: request.businessId,
					contactPhone: request.contactPhone,
					petName: request.pet.name,
					serviceId: request.serviceId,
					startAt: request.startAt,
					endAt: request.endAt,
				});
			},
		}),
	);
	const conversation = new Conversation({
		id: "conversation-local-follow-ups",
		businessId: configuredBusiness.id,
	});

	async function send(message: string) {
		conversation.addMessage("customer", message);
		return orchestrator.handleMessage(message, conversation);
	}

	await send("I would like to book a full groom.");
	await send("415-555-0100");
	await send("Yes");
	await send("Hemant Kumar");
	await send("Milo");
	await send("35 pounds");
	await send("Yes, it is current");
	await send("11th September");
	const confirmationRequest = await send("11am");
	const completed = await send("Yes");

	assert.match(confirmationRequest.reply, /Friday, September 11 at 11:00 AM PDT/);
	assert.equal(completed.outcome.status, "completed");
	assert.match(completed.reply, /Friday, September 11 at 11:00 AM PDT/);
	assert.equal(geminiClient.callCount, 1);
	assert.equal(bookingRequest?.contactPhone, "+14155550100");
	assert.equal(bookingRequest?.startAt, "2026-09-11T18:00:00.000Z");
});

test("preserves dog details while collecting the service needed for a price estimate", async () => {
	const geminiClient = new OneResponseGeminiClient({
		intent: "pricing",
		weightLb: 35,
	});
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		geminiClient,
	);
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		interpreter,
		createDependencies(),
	);
	const conversation = new Conversation({
		id: "conversation-price-follow-up",
		businessId: configuredBusiness.id,
	});

	conversation.addMessage("customer", "What would grooming cost for my 35-pound dog?");
	const serviceQuestion = await orchestrator.handleMessage(
		"What would grooming cost for my 35-pound dog?",
		conversation,
	);
	conversation.addMessage("customer", "Full groom");
	const estimate = await orchestrator.handleMessage("Full groom", conversation);

	assert.equal(serviceQuestion.reply, "Which grooming service would you like pricing for?");
	assert.match(estimate.reply, /Full Groom starts at \$95/);
	assert.equal(geminiClient.callCount, 1);
});

test("escalates oversized pricing once while preserving the selected service", async () => {
	const ownerNotifier = new FakeOwnerNotifier();
	const callLog = new FakeCallLog();
	const contacts = new FakeContacts();
	const interpreter = new SequenceInterpreter([
		{ intent: "pricing", serviceId: "full-groom", weightLb: 50 },
		{ intent: "pricing", weightLb: 100 },
		{ intent: "pricing", weightLb: 110 },
		{ intent: "pricing", contactPhone: "+14155550100" },
		{ intent: "pricing", contactPhoneConfirmed: true },
		{ intent: "pricing", customerName: "Hemant Kumar" },
		{ intent: "pricing", petName: "Tommy" },
	]);
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		interpreter,
		createDependencies(undefined, callLog, ownerNotifier, contacts),
	);
	const conversation = new Conversation({
		id: "conversation-oversized-pricing",
		businessId: configuredBusiness.id,
	});

	const startingPrice = await orchestrator.handleMessage(
		"What is the Full Groom price for a 50 pound dog?",
		conversation,
	);
	const largeDogPrice = await orchestrator.handleMessage(
		"My dog weighs 100 pounds.",
		conversation,
	);
	const oversizedDogPrice = await orchestrator.handleMessage(
		"Sorry, it is 110 pounds.",
		conversation,
	);
	const phoneNumber = await orchestrator.handleMessage("415-555-0100", conversation);
	const phoneConfirmation = await orchestrator.handleMessage("Yes", conversation);
	const customerName = await orchestrator.handleMessage("Hemant Kumar", conversation);
	const ownerNotification = await orchestrator.handleMessage("Tommy", conversation);
	const repeatedHandoffRequest = await orchestrator.handleMessage(
		"Can you connect me with the owner?",
		conversation,
	);

	assert.match(startingPrice.reply, /Full Groom starts at \$95/);
	assert.match(largeDogPrice.reply, /71 to 100 lb require 30 additional minutes/);
	assert.equal(oversizedDogPrice.outcome.status, "needs_information");
	assert.match(oversizedDogPrice.reply, /needs to review this dog's size/);
	assert.match(oversizedDogPrice.reply, /phone number/);
	assert.match(phoneNumber.reply, /best number/);
	assert.match(phoneConfirmation.reply, /What name should the owner use/);
	assert.match(customerName.reply, /dog's name/);
	assert.equal(ownerNotification.outcome.status, "needs_human");
	assert.match(ownerNotification.reply, /sent the details to the owner/);
	assert.match(ownerNotifier.notifications[0] ?? "", /Full Groom/);
	assert.match(ownerNotifier.notifications[0] ?? "", /110 lb/);
	assert.match(ownerNotifier.notifications[0] ?? "", /Hemant Kumar/);
	assert.match(ownerNotifier.notifications[0] ?? "", /Tommy/);
	assert.equal(ownerNotifier.notifications.length, 1);
	assert.match(repeatedHandoffRequest.reply, /already sent the request to the owner/);
	assert.equal(ownerNotifier.notifications.length, 1);

	await orchestrator.endConversation(conversation);
	assert.equal(callLog.entries[0]?.outcome.status, "needs_human");
	assert.equal(callLog.entries[0]?.outcome.callbackRequested, true);
	assert.equal(callLog.entries[0]?.contactPhone, "+14155550100");
	assert.equal(contacts.savedContacts.length, 1);
	assert.equal(contacts.savedContacts[0]?.customer.name, "Hemant Kumar");
	assert.equal(contacts.savedContacts[0]?.pets[0]?.name, "Tommy");
});

test("does not claim an owner handoff when notification fails", async () => {
	const ownerNotifier: OwnerNotifier = {
		async notify(): Promise<void> {
			throw new Error("Telegram is unavailable");
		},
	};
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter({
			intent: "pricing",
			serviceId: "full-groom",
			weightLb: 110,
			contactPhone: "+14155550100",
			contactPhoneConfirmed: true,
			customerName: "Hemant Kumar",
			petName: "Tommy",
		}),
		createDependencies(undefined, undefined, ownerNotifier),
	);
	const conversation = new Conversation({
		id: "conversation-failed-pricing-handoff",
		businessId: configuredBusiness.id,
	});

	const response = await orchestrator.handleMessage(
		"What is the Full Groom price for my 110 pound dog?",
		conversation,
	);

	assert.equal(response.outcome.status, "needs_human");
	assert.match(response.reply, /could not reach the owner notification service/);
	assert.equal(conversation.ownerHandoffNotified, false);
});

test("answers a service details follow-up without repeating the service list", async () => {
	const geminiClient = new OneResponseGeminiClient({ intent: "services" });
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test-key", model: "test-model" },
		geminiClient,
	);
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		interpreter,
		createDependencies(),
	);
	const conversation = new Conversation({
		id: "conversation-service-details",
		businessId: configuredBusiness.id,
	});

	conversation.addMessage("customer", "What services do you offer?");
	const serviceList = await orchestrator.handleMessage(
		"What services do you offer?",
		conversation,
	);
	conversation.addMessage("customer", "What are in the full groom there?");
	const fullGroomDetails = await orchestrator.handleMessage(
		"What are in the full groom there?",
		conversation,
	);

	assert.equal(serviceList.reply, "We offer Bath, Bath and Trim, and Full Groom.");
	assert.match(fullGroomDetails.reply, /complete haircut and style/);
	assert.notEqual(fullGroomDetails.reply, serviceList.reply);
	assert.equal(geminiClient.callCount, 1);
});

test("resumes booking after answering a service details side question", async () => {
	const interpreter = new SequenceInterpreter([
		{ intent: "services", serviceId: "full-groom" },
		{ intent: "book_appointment" },
	]);
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		interpreter,
		createDependencies(),
	);
	const conversation = new Conversation({
		id: "conversation-service-side-question",
		businessId: configuredBusiness.id,
	});
	conversation.updateActiveRequest({
		intent: "book_appointment",
		customerName: "Hemant Kumar",
		contactPhone: "+14155550100",
		contactPhoneConfirmed: true,
		petName: "Tommy",
		weightLb: 35,
		rabiesVaccinationStatus: "current",
		serviceId: "full-groom",
	});
	conversation.confirmContactPhone("+14155550100");
	conversation.recordOutcome(
		createConversationOutcome(
			"needs_information",
			"What day works best for Tommy's Full Groom?",
		),
	);
	conversation.expectCustomerField("requested_date");

	conversation.addMessage("customer", "What does Full Groom include and cost?");
	const detailsResponse = await orchestrator.handleMessage(
		"What does Full Groom include and cost?",
		conversation,
	);
	conversation.addMessage("customer", "Do it for Tommy");
	const resumedResponse = await orchestrator.handleMessage("Do it for Tommy", conversation);

	assert.match(detailsResponse.reply, /complete haircut and style/);
	assert.match(detailsResponse.reply, /what day works best for Tommy's Full Groom/);
	assert.equal(resumedResponse.reply, "What day works best for Tommy's Full Groom?");
	assert.equal(conversation.activeRequest?.intent, "book_appointment");
});

test("preserves booking state for an unrelated question", async () => {
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter({ intent: "unknown" }),
		createDependencies(),
	);
	const conversation = new Conversation({
		id: "conversation-unrelated-question",
		businessId: configuredBusiness.id,
	});

	conversation.updateActiveRequest({
		intent: "book_appointment",
		petName: "Tommy",
		serviceId: "full-groom",
	});
	conversation.recordOutcome(
		createConversationOutcome(
			"needs_information",
			"What day works best for Tommy's Full Groom?",
		),
	);
	conversation.expectCustomerField("requested_date");

	const response = await orchestrator.handleMessage(
		"Can you reverse a linked list?",
		conversation,
	);

	assert.match(response.reply, /focused on dog-grooming questions/);
	assert.match(response.reply, /what day works best for Tommy's Full Groom/);
	assert.equal(conversation.activeRequest?.intent, "book_appointment");
	assert.equal(conversation.expectedCustomerField, "requested_date");
});

test("asks for one missing appointment identity field at a time", async () => {
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter({ intent: "reschedule_appointment" }),
		createDependencies(),
	);

	const result = await orchestrator.handleMessage("Move my appointment", createConversation());

	assert.equal(result.outcome.status, "needs_information");
	assert.equal(result.reply, "What contact phone number is on the appointment?");
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

test("preserves appointment context when persistence fails after a Calendar write", async () => {
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
			async book(): Promise<Appointment> {
				throw new BookingPersistenceError(
					"Appointment was created, but Sheets failed",
					"appointment-partial-1",
				);
			},
		}),
	);

	const result = await orchestrator.handleMessage("Book it", createConversation());

	assert.equal(result.outcome.status, "needs_human");
	assert.equal(result.outcome.appointmentId, "appointment-partial-1");
	assert.match(result.reply, /Calendar change completed/);
});
