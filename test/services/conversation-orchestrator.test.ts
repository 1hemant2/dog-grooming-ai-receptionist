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
	ConversationOutcomeSummarizer,
	Contacts,
	MessageInterpreter,
	OwnerNotifier,
} from "../../src/services/receptionist-dependencies.js";
import {
	createConversationOutcome,
	type ConversationOutcome,
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

class FakeOutcomeSummarizer implements ConversationOutcomeSummarizer {
	readonly outcomes: ConversationOutcome[] = [];

	constructor(private readonly summary: string) {}

	async summarize(
		business: typeof configuredBusiness,
		conversation: Conversation,
		outcome: ConversationOutcome,
	): Promise<string> {
		this.outcomes.push(outcome);
		assert.equal(business.id, configuredBusiness.id);
		assert.equal(conversation.businessId, configuredBusiness.id);
		return this.summary;
	}
}

class FailingOutcomeSummarizer implements ConversationOutcomeSummarizer {
	async summarize(): Promise<string> {
		throw new Error("Gemini is unavailable");
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
	outcomeSummarizer?: ConversationOutcomeSummarizer,
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
		...(outcomeSummarizer ? { outcomeSummarizer } : {}),
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

test("uses the outcome summarizer for the final Call Log summary", async () => {
	const callLog = new FakeCallLog();
	const summarizer = new FakeOutcomeSummarizer(
		"Milo's Bath appointment was booked successfully.",
	);
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter({ intent: "book_appointment" }),
		createDependencies(undefined, callLog, undefined, undefined, undefined, summarizer),
	);
	const conversation = createConversation();
	conversation.recordIntent("book_appointment");
	conversation.recordOutcome(
		createConversationOutcome(
			"completed",
			"What name should I put on the appointment?",
			"appointment-123",
		),
	);

	await orchestrator.endConversation(conversation);

	assert.equal(callLog.entries[0]?.outcome.status, "completed");
	assert.equal(
		callLog.entries[0]?.outcome.summary,
		"Milo's Bath appointment was booked successfully.",
	);
	assert.match(
		summarizer.outcomes[0]?.summary ?? "",
		/^Handled an appointment booking request\. Outcome:/,
	);
});

test("falls back to a deterministic Call Log summary when summarization fails", async () => {
	const callLog = new FakeCallLog();
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter({ intent: "business_hours" }),
		createDependencies(
			undefined,
			callLog,
			undefined,
			undefined,
			undefined,
			new FailingOutcomeSummarizer(),
		),
	);
	const conversation = createConversation();

	await orchestrator.handleMessage("What time do you open?", conversation);
	await orchestrator.endConversation(conversation);

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

test("returns a closing response without interpreting an explicit goodbye", async () => {
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter(new Error("The interpreter should not be called for goodbye")),
		createDependencies(),
	);
	const conversation = createConversation();

	const result = await orchestrator.handleMessage("I don't want to continue", conversation);

	assert.equal(result.outcome.status, "needs_information");
	assert.equal(result.reply, "Thanks for calling Maple Street Dog Grooming. Goodbye!");
	assert.equal(conversation.outcome?.status, "needs_information");
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
		() => new Date("2026-09-10T12:00:00Z"),
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
						new AppointmentSlot("2026-09-12T08:30:00.000Z", "2026-09-12T09:30:00.000Z"),
						new AppointmentSlot("2026-09-12T10:30:00.000Z", "2026-09-12T11:30:00.000Z"),
					],
				};
			}

			return {
				status: "available",
				slots: [
					new AppointmentSlot("2026-09-12T08:30:00.000Z", "2026-09-12T09:30:00.000Z"),
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
						startAt: "2026-09-12T08:30:00.000Z",
						endAt: "2026-09-12T09:30:00.000Z",
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
	assert.match(alternativeResponse.reply, /3:00 PM GMT\+5:30 is not available/);
	assert.match(alternativeResponse.reply, /2:00 PM GMT\+5:30/);
	assert.match(alternativeResponse.reply, /4:00 PM GMT\+5:30/);
	assert.match(confirmationResponse.reply, /confirm/);
	assert.equal(completedResponse.outcome.status, "completed");
	assert.equal(bookingCalled, true);
	assert.equal(conversation.ownerHandoffNotified, false);
});

test("explains when a requested service cannot fit within business hours", async () => {
	let bookingCalled = false;
	const availability: CalendarAvailability = {
		async findAvailableSlots(): Promise<AvailabilityResult> {
			return {
				status: "available",
				slots: [
					new AppointmentSlot("2026-09-14T09:30:00.000Z", "2026-09-14T11:30:00.000Z"),
					new AppointmentSlot("2026-09-15T03:30:00.000Z", "2026-09-15T05:30:00.000Z"),
				],
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
			weightLb: 50,
			rabiesVaccinationStatus: "current",
			serviceId: "full-groom",
			requestedDate: "2026-09-14",
			requestedTime: "18:00",
		}),
		createDependencies(
			{
				async book(): Promise<Appointment> {
					bookingCalled = true;
					throw new Error("Should not be called");
				},
			},
			undefined,
			undefined,
			undefined,
			availability,
		),
		() => new Date("2026-09-12T12:00:00.000Z"),
	);
	const conversation = createConversation();

	const result = await orchestrator.handleMessage("Book it for Monday at 6 PM", conversation);

	assert.equal(result.outcome.status, "needs_information");
	assert.match(result.reply, /outside our business hours/);
	assert.match(result.reply, /open Monday through Saturday from 9:00 AM to 5:00 PM/);
	assert.match(result.reply, /latest start for a Full Groom is 3:00 PM/);
	assert.match(result.reply, /Monday, September 14 at 3:00 PM GMT\+5:30/);
	assert.match(result.reply, /Tuesday, September 15 at 9:00 AM GMT\+5:30/);
	assert.equal(conversation.expectedCustomerField, "requested_time");
	assert.equal(bookingCalled, false);
});

test("explains closed dates before offering the next open-day slots", async () => {
	const availability: CalendarAvailability = {
		async findAvailableSlots(): Promise<AvailabilityResult> {
			return {
				status: "available",
				slots: [
					new AppointmentSlot("2026-09-14T03:30:00.000Z", "2026-09-14T04:30:00.000Z"),
				],
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
			requestedDate: "2026-09-13",
			requestedTime: "14:00",
		}),
		createDependencies(undefined, undefined, undefined, undefined, availability),
		() => new Date("2026-09-12T12:00:00.000Z"),
	);

	const result = await orchestrator.handleMessage(
		"Book it for Sunday at 2 PM",
		createConversation(),
	);

	assert.equal(result.outcome.status, "needs_information");
	assert.match(result.reply, /closed on Sunday/);
	assert.match(result.reply, /open Monday through Saturday from 9:00 AM to 5:00 PM/);
	assert.match(result.reply, /Monday, September 14 at 9:00 AM GMT\+5:30/);
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
	assert.match(ownerNotifier.notifications[0] ?? "", /🚨 APPOINTMENT BOOKING REVIEW/);
	assert.match(ownerNotifier.notifications[0] ?? "", /3:00 PM GMT\+5:30/);
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
	assert.match(result.reply, /I need your dog's name before I can book/);
	assert.equal(conversation.expectedCustomerField, "pet_name");
});

test("asks concise name and phone questions before explaining repeated failures", async () => {
	const phoneOrchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter({ intent: "book_appointment" }),
		createDependencies(),
	);
	const phoneResponse = await phoneOrchestrator.handleMessage(
		"Book an appointment",
		createConversation(),
	);

	assert.equal(phoneResponse.reply, "What phone number should we use for the appointment?");

	const nameOrchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter({
			intent: "book_appointment",
			contactPhone: "+14155550100",
			contactPhoneConfirmed: true,
		}),
		createDependencies(),
	);
	const nameResponse = await nameOrchestrator.handleMessage(
		"Book an appointment",
		createConversation(),
	);

	assert.equal(nameResponse.reply, "What name should I put on the appointment?");
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
		"I haven't booked the appointment yet because a service is required. Which service would you like for Milo? We offer Bath, Bath and Trim, or Full Groom.",
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
	assert.doesNotMatch(confirmationResponse.reply, /can't book the appointment without/);
	assert.match(nameResponse.reply, /I have noted your name as Hemant Kumar/);
	assert.match(nameResponse.reply, /What is your dog's name/);
	assert.equal(conversation.contactPhone, "+14155550100");
	assert.equal(conversation.activeRequest?.customerName, "Hemant Kumar");
	assert.equal(conversation.expectedCustomerField, "pet_name");
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
		() => new Date("2026-09-10T12:00:00.000Z"),
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
	await send("98765-43210");
	await send("Yes");
	await send("Hemant Kumar");
	await send("Milo");
	await send("35 pounds");
	await send("Yes, it is current");
	await send("11th September");
	const confirmationRequest = await send("11am");
	const completed = await send("Go ahead");

	assert.match(confirmationRequest.reply, /Friday, September 11 at 11:00 AM GMT\+5:30/);
	assert.equal(completed.outcome.status, "completed");
	assert.match(completed.reply, /Friday, September 11 at 11:00 AM GMT\+5:30/);
	assert.equal(geminiClient.callCount, 1);
	assert.equal(bookingRequest?.contactPhone, "+919876543210");
	assert.equal(bookingRequest?.startAt, "2026-09-11T05:30:00.000Z");
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
	assert.match(customerName.reply, /I have noted your name as Hemant Kumar/);
	assert.match(customerName.reply, /What is your dog's name/);
	assert.equal(ownerNotification.outcome.status, "needs_human");
	assert.match(ownerNotification.reply, /sent the details to the owner/);
	assert.match(ownerNotifier.notifications[0] ?? "", /⚠️ PRICING REVIEW REQUIRED/);
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
	assert.equal(
		resumedResponse.reply,
		"I need an appointment date before I can book. What day works best for Tommy's Full Groom?",
	);
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

test("includes the current and proposed times in reschedule confirmation", async () => {
	const existingAppointment = new Appointment({
		id: "appointment-to-reschedule",
		businessId: configuredBusiness.id,
		contactPhone: "+14155550100",
		petName: "Roni",
		serviceId: "bath",
		startAt: "2026-09-11T09:30:00.000Z",
		endAt: "2026-09-11T10:30:00.000Z",
	});
	const dependencies = createDependencies();
	dependencies.management = {
		async findAppointments() {
			return { status: "found", appointments: [existingAppointment] };
		},
		async reschedule() {
			throw new Error("Reschedule should wait for confirmation");
		},
		async cancel() {
			throw new Error("Not used in this test");
		},
	};
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter({
			intent: "reschedule_appointment",
			customerName: "Alex Morgan",
			contactPhone: "+14155550100",
			contactPhoneConfirmed: true,
			petName: "Roni",
			requestedDate: "2026-09-12",
			requestedTime: "15:00",
		}),
		dependencies,
	);

	const result = await orchestrator.handleMessage(
		"Move it to tomorrow at 3 PM",
		createConversation(),
	);

	assert.equal(result.outcome.status, "needs_information");
	assert.equal(
		result.reply,
		"I found Roni's Bath appointment for Friday, September 11 at 3:00 PM GMT+5:30. Would you like me to reschedule it to Saturday, September 12 at 3:00 PM GMT+5:30?",
	);
});

test("rejected phone numbers are discarded and replacements require confirmation", async () => {
	const interpreter = new SequenceInterpreter([
		{ intent: "book_appointment", contactPhone: "+919534909390" },
		{ intent: "book_appointment", contactPhoneConfirmed: false },
		{ intent: "book_appointment", contactPhone: "+919876543210" },
		{ intent: "book_appointment", contactPhoneConfirmed: true },
	]);
	const conversation = createConversation();
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		interpreter,
		createDependencies(),
	);
	await orchestrator.handleMessage("9534909390", conversation);
	const rejected = await orchestrator.handleMessage("No, it's not correct", conversation);
	assert.equal(rejected.reply, "Please say the correct ten-digit number.");
	assert.equal(conversation.activeRequest?.contactPhone, undefined);
	assert.equal(conversation.expectedCustomerField, "contact_phone");
	await orchestrator.handleMessage("9876543210", conversation);
	assert.equal(conversation.contactPhone, undefined);
	assert.equal(conversation.expectedCustomerField, "contact_phone_confirmation");
	await orchestrator.handleMessage("Yes", conversation);
	assert.equal(conversation.contactPhone, "+919876543210");
});

test("name corrections update the captured name while collecting the pet name", async () => {
	const interpreter = new GeminiMessageInterpreter(
		{ apiKey: "test", model: "test" },
		new OneResponseGeminiClient({
			intent: "book_appointment",
			contactPhone: "+919876543210",
			contactPhoneConfirmed: true,
		}),
	);
	const conversation = createConversation();
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		interpreter,
		createDependencies(),
	);
	await orchestrator.handleMessage("Book", conversation);
	const heard = await orchestrator.handleMessage("Payment", conversation);
	assert.match(heard.reply, /I have noted your name as Payment/);
	assert.match(heard.reply, /What is your dog's name/);
	const correction = await orchestrator.handleMessage(
		"Actually, my name is H E M A N T",
		conversation,
	);
	assert.match(correction.reply, /updated your name to HEMANT/);
	assert.equal(conversation.activeRequest?.customerNameConfirmed, true);
	assert.equal(conversation.expectedCustomerField, "pet_name");
	assert.equal(conversation.activeRequest?.customerName, "HEMANT");
});

test("repeated incomplete numbers explain why booking and callback cannot proceed", async () => {
	const interpreter = new SequenceInterpreter(
		Array.from({ length: 4 }, () => ({ intent: "book_appointment" })),
	);
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		interpreter,
		createDependencies(),
	);
	const conversation = createConversation();
	await orchestrator.handleMessage("Book", conversation);
	await orchestrator.handleMessage("9534", conversation);
	await orchestrator.handleMessage("9534", conversation);
	const result = await orchestrator.handleMessage("9534", conversation);
	assert.match(result.reply, /nothing has been booked/);
	assert.match(result.reply, /text chat/);
	assert.equal(conversation.contactPhone, undefined);
});

test("changing booking details invalidates a yes and requires fresh approval", async () => {
	let bookings = 0;
	const details: InterpretedMessage = {
		intent: "book_appointment",
		customerName: "Hemant",
		contactPhone: "+919876543210",
		contactPhoneConfirmed: true,
		petName: "Milo",
		weightLb: 25,
		rabiesVaccinationStatus: "current",
		serviceId: "bath",
		requestedDate: "2026-09-12",
		requestedTime: "10:00",
	};
	const interpreter = new SequenceInterpreter([
		details,
		{ intent: "book_appointment", requestedTime: "11:00", confirmation: true },
		{ intent: "book_appointment", confirmation: true },
	]);
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		interpreter,
		createDependencies({
			async book(request) {
				bookings += 1;
				return new Appointment({
					id: "corrected",
					businessId: request.businessId,
					contactPhone: request.contactPhone,
					petName: request.pet.name,
					serviceId: request.serviceId,
					startAt: request.startAt,
					endAt: request.endAt,
				});
			},
		}),
		() => new Date("2026-09-10T12:00:00Z"),
	);
	const conversation = createConversation();
	await orchestrator.handleMessage("Book a bath", conversation);
	const correction = await orchestrator.handleMessage("Yes, but make it 11", conversation);
	assert.equal(bookings, 0);
	assert.match(correction.reply, /Should I book it/);
	assert.match(correction.reply, /Hemant/);
	assert.equal(conversation.activeRequest?.confirmation, undefined);
	const result = await orchestrator.handleMessage("Yes", conversation);
	assert.equal(result.outcome.appointmentId, "corrected");
	assert.equal(bookings, 1);
});

test("declining a booking proposal does not create an appointment", async () => {
	const conversation = createConversation();
	conversation.updateActiveRequest({
		intent: "book_appointment",
		requestedDate: "2026-09-12",
		requestedTime: "10:00",
	});
	conversation.recordOutcome(
		createConversationOutcome("needs_information", "Awaiting approval."),
	);
	conversation.expectCustomerField("appointment_confirmation");
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter({ intent: "book_appointment", confirmation: false }),
		createDependencies({
			async book() {
				throw new Error("Must not book");
			},
		}),
	);
	const result = await orchestrator.handleMessage("No", conversation);
	assert.match(result.reply, /haven't booked/);
	assert.equal(conversation.activeRequest?.requestedDate, undefined);
	assert.equal(conversation.expectedCustomerField, "requested_date");
});

test("missing or unconfirmed required fields block booking even when the interpreter says yes", async (t) => {
	const complete: InterpretedMessage = {
		intent: "book_appointment",
		customerName: "Hemant",
		customerNameConfirmed: true,
		contactPhone: "+919876543210",
		contactPhoneConfirmed: true,
		petName: "Milo",
		weightLb: 25,
		rabiesVaccinationStatus: "current",
		serviceId: "bath",
		requestedDate: "2026-09-12",
		requestedTime: "10:00",
		confirmation: true,
	};
	const cases: Array<{ field: keyof InterpretedMessage; expected: string }> = [
		{ field: "contactPhone", expected: "contact_phone" },
		{ field: "contactPhoneConfirmed", expected: "contact_phone_confirmation" },
		{ field: "customerName", expected: "customer_name" },
		{ field: "petName", expected: "pet_name" },
		{ field: "weightLb", expected: "dog_weight" },
		{ field: "rabiesVaccinationStatus", expected: "rabies_status" },
		{ field: "serviceId", expected: "service" },
		{ field: "requestedDate", expected: "requested_date" },
		{ field: "requestedTime", expected: "requested_time" },
		{ field: "confirmation", expected: "appointment_confirmation" },
	];
	for (const scenario of cases)
		await t.test(scenario.field, async () => {
			const incomplete = { ...complete };
			delete incomplete[scenario.field];
			let calls = 0;
			const orchestrator = new ConversationOrchestrator(
				configuredBusiness,
				new FakeInterpreter(incomplete),
				createDependencies({
					async book() {
						calls += 1;
						throw new Error("Must not book");
					},
				}),
				() => new Date("2026-09-10T12:00:00Z"),
			);
			const conversation = createConversation();
			const result = await orchestrator.handleMessage("Yes, book it", conversation);
			assert.equal(result.outcome.status, "needs_information");
			assert.equal(result.outcome.appointmentId, undefined);
			assert.equal(conversation.expectedCustomerField, scenario.expected);
			assert.match(
				result.reply,
				/What (?:phone number|name)|before I can|isn't booked yet|haven't booked|can't book|need .* before|before booking|until we establish/i,
			);
			assert.equal(calls, 0);
		});
});

test("booking service failure produces an explicit uncertain-booking response", async () => {
	const details: InterpretedMessage = {
		intent: "book_appointment",
		customerName: "Hemant",
		contactPhone: "+919876543210",
		contactPhoneConfirmed: true,
		petName: "Milo",
		weightLb: 25,
		rabiesVaccinationStatus: "current",
		serviceId: "bath",
		requestedDate: "2026-09-12",
		requestedTime: "10:00",
		confirmation: true,
	};
	const orchestrator = new ConversationOrchestrator(
		configuredBusiness,
		new FakeInterpreter(details),
		createDependencies({
			async book() {
				throw new Error("Calendar unavailable");
			},
		}),
		() => new Date("2026-09-10T12:00:00Z"),
	);
	const result = await orchestrator.handleMessage("Book it", createConversation());
	assert.equal(result.outcome.status, "needs_human");
	assert.match(result.reply, /couldn't confirm that your appointment was booked/);
	assert.equal(result.outcome.appointmentId, undefined);
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
		() => new Date("2026-09-10T12:00:00Z"),
	);
	const conversation = createConversation();

	const result = await orchestrator.handleMessage("Book it", conversation);

	assert.equal(result.outcome.status, "completed");
	assert.equal(receivedRequest?.contactPhone, "+14155550100");
	assert.equal(receivedRequest?.pet.name, "Milo");
	assert.equal(receivedRequest?.startAt, "2026-09-12T04:30:00.000Z");
	assert.equal(receivedRequest?.endAt, "2026-09-12T05:30:00.000Z");
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
		() => new Date("2026-09-10T12:00:00Z"),
	);

	const result = await orchestrator.handleMessage("Book it", createConversation());

	assert.equal(result.outcome.status, "needs_human");
	assert.equal(result.outcome.appointmentId, "appointment-partial-1");
	assert.match(result.reply, /Calendar change completed/);
});
