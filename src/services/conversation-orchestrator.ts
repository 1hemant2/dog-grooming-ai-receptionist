import type { Appointment } from "../models/appointment.js";
import type { BusinessConfig, ServiceId } from "../models/business.js";
import type { Conversation } from "../models/conversation.js";
import type { PetDetails } from "../models/customer.js";
import {
	createConversationOutcome,
	type ConversationOutcome,
	type ExpectedCustomerField,
	type InterpretedMessage,
	type ReceptionistIntent,
} from "../models/receptionist.js";
import { formatLocalDateTime, localDateTimeToDate } from "./calendar-time.js";
import {
	BookingPersistenceError,
	type AppointmentBookingRequest,
	type AppointmentBookingService,
} from "./appointment-booking.js";
import {
	AppointmentChangePersistenceError,
	type AppointmentIdentity,
	type AppointmentLookupResult,
	type AppointmentManagementService,
	type CancelAppointmentRequest,
	OwnerNotificationError,
	type RescheduleAppointmentRequest,
} from "./appointment-management.js";
import type { BusinessInformationService } from "./business-information.js";
import { getAppointmentDuration } from "./calendar-availability.js";
import type {
	ComplaintRequest,
	CustomerSupportService,
	LateArrivalRequest,
	CustomerSupportResult,
} from "./customer-support.js";
import { AppointmentSlot } from "../models/appointment.js";
import type { CallLog, MessageInterpreter, OwnerNotifier } from "./receptionist-dependencies.js";

export interface ConversationResponse {
	reply: string;
	outcome: ConversationOutcome;
}

export interface ConversationMessageHandler {
	handleMessage(message: string, conversation: Conversation): Promise<ConversationResponse>;
	endConversation(conversation: Conversation): Promise<void>;
}

export interface ConversationOrchestratorDependencies {
	callLog: CallLog;
	information: Pick<
		BusinessInformationService,
		| "answerServices"
		| "answerPricing"
		| "answerBusinessHours"
		| "answerBreedOrSize"
		| "answerVaccination"
	>;
	booking: Pick<AppointmentBookingService, "book">;
	management: Pick<AppointmentManagementService, "findAppointments" | "reschedule" | "cancel">;
	support: Pick<CustomerSupportService, "handleLateArrival" | "recordComplaint">;
	ownerNotifier: Pick<OwnerNotifier, "notify">;
}

interface AppointmentIdentityWithConversation extends AppointmentIdentity {
	conversationId: string;
	callerPhone?: string;
}

interface AppointmentLookup {
	appointment?: Appointment;
	reason?: string;
	response?: ConversationResponse;
}

export class ConversationOrchestrator implements ConversationMessageHandler {
	constructor(
		private readonly business: BusinessConfig,
		private readonly interpreter: MessageInterpreter,
		private readonly dependencies: ConversationOrchestratorDependencies,
		private readonly clock: () => Date = () => new Date(),
	) {}

	async endConversation(conversation: Conversation): Promise<void> {
		if (conversation.businessId !== this.business.id) {
			throw new Error("Conversation does not belong to the configured business");
		}

		const outcome =
			conversation.outcome ??
			createConversationOutcome(
				"needs_information",
				"The conversation ended before the request was completed.",
			);
		const intents: readonly ReceptionistIntent[] =
			conversation.intents.length > 0 ? conversation.intents : ["unknown"];

		await this.dependencies.callLog.append({
			businessId: conversation.businessId,
			conversationId: conversation.id,
			intents,
			outcome,
			endedAt: this.clock().toISOString(),
			...(conversation.callerPhone ? { callerPhone: conversation.callerPhone } : {}),
			...(conversation.contactPhone ? { contactPhone: conversation.contactPhone } : {}),
		});
	}

	async handleMessage(
		message: string,
		conversation: Conversation,
	): Promise<ConversationResponse> {
		if (conversation.businessId !== this.business.id) {
			throw new Error("Conversation does not belong to the configured business");
		}

		if (conversation.ownerHandoffNotified) {
			const outcome =
				conversation.outcome ??
				createConversationOutcome(
					"needs_human",
					"The request has already been sent to the owner for review.",
				);
			return this.finish(
				conversation,
				"I’ve already sent the request to the owner. They will call you back.",
				outcome,
			);
		}

		let interpretedMessage: InterpretedMessage;

		try {
			interpretedMessage = await this.interpreter.interpret(
				message,
				this.business,
				conversation,
			);
		} catch (error) {
			const errorMessage = error instanceof Error ? error.message : String(error);
			console.error(`Message interpretation failed: ${errorMessage}`, {
				businessId: conversation.businessId,
				conversationId: conversation.id,
				outcomeStatus: "needs_information",
				errorName: error instanceof Error ? error.constructor.name : "UnknownError",
				errorMessage,
			});
			return this.finish(
				conversation,
				"I’m sorry, I could not safely understand that request. Could you rephrase it?",
				createConversationOutcome(
					"needs_information",
					"The customer message needs clarification before the receptionist can continue.",
				),
			);
		}

		const pricingHandoffResponse = await this.continuePricingHandoff(
			interpretedMessage,
			conversation,
		);
		if (pricingHandoffResponse) return pricingHandoffResponse;

		const interruptionResponse = await this.handleInterruptionDuringActiveRequest(
			interpretedMessage,
			conversation,
		);
		if (interruptionResponse) return interruptionResponse;

		interpretedMessage = conversation.updateActiveRequest(interpretedMessage);

		const contactPhoneResult = this.applyConfirmedContactPhone(
			interpretedMessage,
			conversation,
		);
		if (contactPhoneResult) {
			return contactPhoneResult;
		}

		conversation.recordIntent(interpretedMessage.intent);

		try {
			return await this.routeMessage(interpretedMessage, message, conversation);
		} catch (error) {
			const partialWriteFailure =
				error instanceof BookingPersistenceError ||
				error instanceof AppointmentChangePersistenceError ||
				error instanceof OwnerNotificationError;
			const appointmentId = partialWriteFailure ? error.appointmentId : undefined;

			console.error("Conversation action failed.", {
				businessId: conversation.businessId,
				conversationId: conversation.id,
				intents: conversation.intents,
				outcomeStatus: "needs_human",
				...(appointmentId ? { appointmentId } : {}),
				errorName: error instanceof Error ? error.constructor.name : "UnknownError",
			});

			if (partialWriteFailure) {
				return this.finish(
					conversation,
					"The Calendar change completed, but a follow-up step failed. The owner needs to verify the records before another change is attempted.",
					createConversationOutcome(
						"needs_human",
						"Calendar was changed, but a follow-up record or notification failed. Owner review is required.",
						appointmentId,
					),
				);
			}

			return this.finish(
				conversation,
				"I could not safely complete that request. The owner needs to review it.",
				createConversationOutcome(
					"needs_human",
					"The requested action could not be completed safely and requires owner review.",
				),
			);
		}
	}

	private async handleInterruptionDuringActiveRequest(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): Promise<ConversationResponse | undefined> {
		const activeRequest = conversation.activeRequest;
		const expectedCustomerField = conversation.expectedCustomerField;

		if (!activeRequest || !expectedCustomerField) return undefined;

		switch (interpretedMessage.intent) {
			case "services":
				return this.answerServicesDuringActiveRequest(
					interpretedMessage,
					activeRequest,
					conversation,
					expectedCustomerField,
				);
			case "pricing":
				return this.answerPricingDuringActiveRequest(
					interpretedMessage,
					activeRequest,
					conversation,
					expectedCustomerField,
				);
			case "business_hours":
				return this.finishInterruption(
					conversation,
					expectedCustomerField,
					interpretedMessage.intent,
					this.dependencies.information.answerBusinessHours(interpretedMessage.dayName),
				);
			case "breed_or_size":
				return this.answerBreedOrSizeDuringActiveRequest(
					interpretedMessage,
					activeRequest,
					conversation,
					expectedCustomerField,
				);
			case "vaccination":
				return this.finishInterruption(
					conversation,
					expectedCustomerField,
					interpretedMessage.intent,
					this.dependencies.information.answerVaccination(),
				);
			case "unknown":
				return this.finishInterruption(
					conversation,
					expectedCustomerField,
					interpretedMessage.intent,
					createConversationOutcome(
						"answered",
						"I’m focused on dog-grooming questions. I can help with services, pricing, hours, appointments, vaccinations, or complaints.",
					),
				);
			default:
				return undefined;
		}
	}

	private async continuePricingHandoff(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): Promise<ConversationResponse | undefined> {
		if (!this.isCollectingPricingHandoff(conversation)) return undefined;

		const updatedRequest = conversation.updateActiveRequest(interpretedMessage);
		const contactPhoneResult = this.applyConfirmedContactPhone(updatedRequest, conversation);
		if (contactPhoneResult) return contactPhoneResult;

		return this.collectPricingHandoffDetails(updatedRequest, conversation);
	}

	private isCollectingPricingHandoff(conversation: Conversation): boolean {
		const activeRequest = conversation.activeRequest;

		return (
			conversation.outcome?.status === "needs_information" &&
			conversation.expectedCustomerField !== undefined &&
			activeRequest?.intent === "pricing" &&
			activeRequest.weightLb !== undefined &&
			activeRequest.weightLb > this.business.humanReviewWeightLb
		);
	}

	private answerServicesDuringActiveRequest(
		interpretedMessage: InterpretedMessage,
		activeRequest: Readonly<InterpretedMessage>,
		conversation: Conversation,
		expectedCustomerField: ExpectedCustomerField,
	): ConversationResponse {
		let requestedServiceNames = interpretedMessage.requestedServiceNames;

		if (!requestedServiceNames) {
			const requestedServiceName =
				interpretedMessage.serviceName ?? interpretedMessage.serviceId;
			if (requestedServiceName) requestedServiceNames = [requestedServiceName];
		}

		const serviceOutcome = this.dependencies.information.answerServices(requestedServiceNames);
		return this.finishInterruption(
			conversation,
			expectedCustomerField,
			interpretedMessage.intent,
			serviceOutcome,
			activeRequest,
		);
	}

	private async answerPricingDuringActiveRequest(
		interpretedMessage: InterpretedMessage,
		activeRequest: Readonly<InterpretedMessage>,
		conversation: Conversation,
		expectedCustomerField: ExpectedCustomerField,
	): Promise<ConversationResponse> {
		const serviceName =
			interpretedMessage.serviceName ??
			interpretedMessage.serviceId ??
			activeRequest.serviceName ??
			activeRequest.serviceId;
		const weightLb = interpretedMessage.weightLb ?? activeRequest.weightLb;
		const outcome = this.dependencies.information.answerPricing(serviceName, weightLb);

		if (outcome.status === "needs_human") {
			conversation.recordIntent(interpretedMessage.intent);
			return this.beginPricingHandoff(
				interpretedMessage,
				conversation,
				outcome,
				activeRequest,
			);
		}

		return this.finishInterruption(
			conversation,
			expectedCustomerField,
			interpretedMessage.intent,
			outcome,
			activeRequest,
		);
	}

	private answerBreedOrSizeDuringActiveRequest(
		interpretedMessage: InterpretedMessage,
		activeRequest: Readonly<InterpretedMessage>,
		conversation: Conversation,
		expectedCustomerField: ExpectedCustomerField,
	): ConversationResponse {
		const serviceName =
			interpretedMessage.serviceName ??
			interpretedMessage.serviceId ??
			activeRequest.serviceName ??
			activeRequest.serviceId;
		const breedOrMix = interpretedMessage.breedOrMix ?? activeRequest.breedOrMix;
		const weightLb = interpretedMessage.weightLb ?? activeRequest.weightLb;
		const safetyConcern = interpretedMessage.safetyConcern ?? activeRequest.safetyConcern;
		const question = {
			...(serviceName ? { serviceName } : {}),
			...(breedOrMix ? { breedOrMix } : {}),
			...(weightLb !== undefined ? { weightLb } : {}),
			...(safetyConcern ? { safetyConcern } : {}),
		};

		return this.finishInterruption(
			conversation,
			expectedCustomerField,
			interpretedMessage.intent,
			this.dependencies.information.answerBreedOrSize(question),
			activeRequest,
		);
	}

	private finishInterruption(
		conversation: Conversation,
		expectedCustomerField: ExpectedCustomerField,
		intent: ReceptionistIntent,
		outcome: ConversationOutcome,
		activeRequest?: Readonly<InterpretedMessage>,
	): ConversationResponse {
		conversation.recordIntent(intent);

		if (outcome.status === "needs_human") {
			return this.finish(conversation, outcome.summary, outcome);
		}

		const continuationPrompt = this.getBookingContinuationPrompt(
			activeRequest ?? conversation.activeRequest,
			expectedCustomerField,
		);
		const reply = continuationPrompt
			? `${outcome.summary} ${continuationPrompt}`
			: outcome.summary;
		const response = this.finish(
			conversation,
			reply,
			createConversationOutcome("needs_information", reply),
		);
		conversation.expectCustomerField(expectedCustomerField);
		return response;
	}

	private getBookingContinuationPrompt(
		activeRequest: Readonly<InterpretedMessage> | undefined,
		expectedCustomerField: ExpectedCustomerField,
	): string | undefined {
		const petName = activeRequest?.petName ?? "your dog";
		const service = activeRequest ? this.findService(activeRequest) : undefined;
		const serviceName = service?.name ?? "grooming appointment";

		switch (expectedCustomerField) {
			case "requested_date":
				return `If you'd like to continue, what day works best for ${petName}'s ${serviceName}?`;
			case "requested_time":
				return "If you'd like to continue, what time would you prefer that day?";
			case "customer_name":
				return "If you'd like to continue, what name should I put on the appointment?";
			case "contact_phone":
				return "If you'd like to continue, what phone number should we use for the appointment?";
			default:
				return undefined;
		}
	}

	private applyConfirmedContactPhone(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): ConversationResponse | undefined {
		if (interpretedMessage.contactPhoneConfirmed && !interpretedMessage.contactPhone) {
			if (!conversation.contactPhone) {
				return this.ask(
					conversation,
					"What phone number would you like us to use?",
					"contact_phone",
				);
			}

			return undefined;
		}

		if (interpretedMessage.contactPhone && interpretedMessage.contactPhoneConfirmed === true) {
			if (
				conversation.contactPhone &&
				conversation.contactPhone !== interpretedMessage.contactPhone
			) {
				return this.ask(
					conversation,
					"This conversation already has a different confirmed contact number. Please continue with that number or start a new conversation.",
				);
			}

			conversation.confirmContactPhone(interpretedMessage.contactPhone);
		}

		return undefined;
	}

	private async routeMessage(
		interpretedMessage: InterpretedMessage,
		message: string,
		conversation: Conversation,
	): Promise<ConversationResponse> {
		switch (interpretedMessage.intent) {
			case "services":
				return this.answerServices(interpretedMessage, conversation);
			case "pricing":
				return this.answerPricing(interpretedMessage, conversation);
			case "business_hours":
				return this.answerBusinessHours(interpretedMessage, conversation);
			case "breed_or_size":
				return this.answerBreedOrSize(interpretedMessage, conversation);
			case "vaccination":
				return this.answerVaccination(conversation);
			case "book_appointment":
				return this.bookAppointment(interpretedMessage, conversation);
			case "reschedule_appointment":
				return this.rescheduleAppointment(interpretedMessage, conversation);
			case "cancel_appointment":
				return this.cancelAppointment(interpretedMessage, conversation);
			case "running_late":
				return this.handleLateArrival(interpretedMessage, conversation);
			case "complaint":
				return this.handleComplaint(interpretedMessage, message, conversation);
			case "unknown":
				return this.ask(
					conversation,
					"I can help with services, pricing, hours, grooming suitability, appointments, late arrivals, and complaints. What would you like help with?",
				);
		}
	}

	private answerServices(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): ConversationResponse {
		let requestedServiceNames = interpretedMessage.requestedServiceNames;

		if (!requestedServiceNames && interpretedMessage.serviceName) {
			requestedServiceNames = [interpretedMessage.serviceName];
		}

		return this.finishWithOutcome(
			conversation,
			this.dependencies.information.answerServices(requestedServiceNames),
		);
	}

	private async answerPricing(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): Promise<ConversationResponse> {
		if (!interpretedMessage.serviceName && !interpretedMessage.serviceId) {
			return this.ask(
				conversation,
				"Which grooming service would you like pricing for?",
				"service",
			);
		}

		const outcome = this.dependencies.information.answerPricing(
			interpretedMessage.serviceName ?? interpretedMessage.serviceId,
			interpretedMessage.weightLb,
		);

		if (outcome.status === "needs_human") {
			return this.beginPricingHandoff(interpretedMessage, conversation, outcome);
		}

		return this.finishWithOutcome(conversation, outcome);
	}

	private async beginPricingHandoff(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
		outcome: ConversationOutcome,
		activeRequest?: Readonly<InterpretedMessage>,
	): Promise<ConversationResponse> {
		conversation.recordIntent("pricing");
		const pricingRequest = this.buildPricingRequest(interpretedMessage, activeRequest);
		const updatedRequest = conversation.updateActiveRequest(pricingRequest);
		const contactPhoneResult = this.applyConfirmedContactPhone(updatedRequest, conversation);
		if (contactPhoneResult) return contactPhoneResult;

		return this.collectPricingHandoffDetails(updatedRequest, conversation, outcome);
	}

	private async collectPricingHandoffDetails(
		pricingRequest: InterpretedMessage,
		conversation: Conversation,
		initialOutcome?: ConversationOutcome,
	): Promise<ConversationResponse> {
		const handoffReason =
			initialOutcome?.summary ??
			"A groomer needs to review this dog's size before we provide a price estimate.";

		if (!conversation.contactPhone) {
			if (pricingRequest.contactPhone) {
				return this.ask(
					conversation,
					`${handoffReason} I have ${pricingRequest.contactPhone}. Is that the best number for the owner to call you back?`,
					"contact_phone_confirmation",
				);
			}

			return this.ask(
				conversation,
				`${handoffReason} What phone number should the owner use to call you back?`,
				"contact_phone",
			);
		}

		if (!pricingRequest.customerName) {
			return this.ask(
				conversation,
				"What name should the owner use when calling you back?",
				"customer_name",
			);
		}

		if (!pricingRequest.petName) {
			return this.ask(conversation, "What is your dog's name?", "pet_name");
		}

		const service = this.findService(pricingRequest);
		const outcome =
			initialOutcome ??
			this.dependencies.information.answerPricing(
				service?.id ?? pricingRequest.serviceName ?? pricingRequest.serviceId,
				pricingRequest.weightLb,
			);

		if (outcome.status !== "needs_human") {
			return this.finishWithOutcome(conversation, outcome);
		}

		return this.escalatePricingReview(pricingRequest, conversation, outcome);
	}

	private buildPricingRequest(
		interpretedMessage: InterpretedMessage,
		activeRequest?: Readonly<InterpretedMessage>,
	): InterpretedMessage {
		return {
			...(activeRequest ?? {}),
			...interpretedMessage,
			intent: "pricing",
			...(activeRequest?.serviceId && !interpretedMessage.serviceId
				? { serviceId: activeRequest.serviceId }
				: {}),
			...(activeRequest?.serviceName && !interpretedMessage.serviceName
				? { serviceName: activeRequest.serviceName }
				: {}),
			...(activeRequest?.weightLb !== undefined && interpretedMessage.weightLb === undefined
				? { weightLb: activeRequest.weightLb }
				: {}),
		};
	}

	private async escalatePricingReview(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
		outcome: ConversationOutcome,
		activeRequest?: Readonly<InterpretedMessage>,
	): Promise<ConversationResponse> {
		const pricingRequest = this.buildPricingRequest(interpretedMessage, activeRequest);
		const service = this.findService(pricingRequest);
		const notification = [
			"Pricing review required for an oversized dog.",
			`Business: ${this.business.name}`,
			`Conversation: ${conversation.id}`,
			`Customer: ${pricingRequest.customerName ?? "Not provided"}`,
			`Contact phone: ${conversation.contactPhone ?? pricingRequest.contactPhone ?? "Not provided"}`,
			`Pet: ${pricingRequest.petName ?? "Not provided"}`,
			`Service: ${service?.name ?? pricingRequest.serviceName ?? pricingRequest.serviceId ?? "Not provided"}`,
			`Weight: ${pricingRequest.weightLb !== undefined ? `${pricingRequest.weightLb} lb` : "Not provided"}`,
			`Reason: ${outcome.summary}`,
		].join("\n");

		try {
			await this.dependencies.ownerNotifier.notify(notification);
			conversation.markOwnerHandoffNotified();
		} catch (error) {
			console.error("Pricing handoff notification failed.", {
				businessId: conversation.businessId,
				conversationId: conversation.id,
				errorName: error instanceof Error ? error.constructor.name : "UnknownError",
			});

			return this.finish(
				conversation,
				`${outcome.summary} I could not reach the owner notification service, so please contact the shop directly as well.`,
				outcome,
			);
		}

		return this.finish(
			conversation,
			`${outcome.summary} I’ve sent the details to the owner, and they will call you back.`,
			outcome,
		);
	}

	private answerBusinessHours(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): ConversationResponse {
		return this.finishWithOutcome(
			conversation,
			this.dependencies.information.answerBusinessHours(interpretedMessage.dayName),
		);
	}

	private answerBreedOrSize(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): ConversationResponse {
		const question = {
			...(interpretedMessage.serviceName || interpretedMessage.serviceId
				? { serviceName: interpretedMessage.serviceName ?? interpretedMessage.serviceId }
				: {}),
			...(interpretedMessage.breedOrMix ? { breedOrMix: interpretedMessage.breedOrMix } : {}),
			...(interpretedMessage.weightLb !== undefined
				? { weightLb: interpretedMessage.weightLb }
				: {}),
			...(interpretedMessage.safetyConcern
				? { safetyConcern: interpretedMessage.safetyConcern }
				: {}),
		};

		return this.finishWithOutcome(
			conversation,
			this.dependencies.information.answerBreedOrSize(question),
		);
	}

	private answerVaccination(conversation: Conversation): ConversationResponse {
		return this.finishWithOutcome(
			conversation,
			this.dependencies.information.answerVaccination(),
		);
	}

	private async bookAppointment(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): Promise<ConversationResponse> {
		const contactPhone = this.getContactPhone(interpretedMessage, conversation);
		if (!contactPhone) {
			if (interpretedMessage.contactPhone) {
				return this.ask(
					conversation,
					`I have ${interpretedMessage.contactPhone}. Is that the best number to use for the appointment?`,
					"contact_phone_confirmation",
				);
			}

			return this.ask(
				conversation,
				"What phone number should we use for the appointment?",
				"contact_phone",
			);
		}

		if (!interpretedMessage.customerName) {
			return this.ask(
				conversation,
				"What name should I put on the appointment?",
				"customer_name",
			);
		}

		if (!interpretedMessage.petName) {
			return this.ask(conversation, "And what is your dog's name?", "pet_name");
		}

		if (interpretedMessage.weightLb === undefined) {
			return this.ask(
				conversation,
				`About how much does ${interpretedMessage.petName} weigh in pounds?`,
				"dog_weight",
			);
		}

		if (interpretedMessage.rabiesVaccinationStatus === undefined) {
			return this.ask(
				conversation,
				`Is ${interpretedMessage.petName}'s rabies vaccination up to date?`,
				"rabies_status",
			);
		}

		const pet: PetDetails = {
			name: interpretedMessage.petName,
			weightLb: interpretedMessage.weightLb,
			rabiesVaccinationStatus: interpretedMessage.rabiesVaccinationStatus,
		};

		if (interpretedMessage.breedOrMix) pet.breedOrMix = interpretedMessage.breedOrMix;
		if (interpretedMessage.healthConcerns)
			pet.healthConcerns = interpretedMessage.healthConcerns;
		if (interpretedMessage.behaviorConcerns) {
			pet.behaviorConcerns = interpretedMessage.behaviorConcerns;
		}

		const service = this.findService(interpretedMessage);
		if (!service) {
			return this.ask(
				conversation,
				`Which service would you like for ${pet.name}? We offer ${formatChoices(
					this.business.services.map((availableService) => availableService.name),
				)}.`,
				"service",
			);
		}

		if (!interpretedMessage.requestedDate) {
			return this.ask(
				conversation,
				`What day works best for ${pet.name}'s ${service.name}?`,
				"requested_date",
			);
		}

		if (!interpretedMessage.requestedTime) {
			return this.ask(conversation, "What time would you prefer that day?", "requested_time");
		}

		const slot = this.createRequestedSlot(
			interpretedMessage.requestedDate,
			interpretedMessage.requestedTime,
			getAppointmentDuration(this.business, service.durationMinutes, pet.weightLb),
		);

		if (interpretedMessage.confirmation !== true) {
			const appointmentTime = formatLocalDateTime(slot.startAt, this.business.timezone);
			return this.ask(
				conversation,
				`Just to confirm: ${service.name} for ${pet.name} on ${appointmentTime}. Should I book it?`,
				"appointment_confirmation",
			);
		}

		const request: AppointmentBookingRequest = {
			businessId: this.business.id,
			conversationId: conversation.id,
			customerName: interpretedMessage.customerName,
			contactPhone,
			pet,
			serviceId: service.id,
			startAt: slot.startAt,
			endAt: slot.endAt,
			confirmed: true,
			...(conversation.callerPhone ? { callerPhone: conversation.callerPhone } : {}),
			...(interpretedMessage.safetyConcern
				? { safetyConcern: interpretedMessage.safetyConcern }
				: {}),
		};
		const appointment = await this.dependencies.booking.book(request);
		const outcome = createConversationOutcome(
			"completed",
			`${service.name} appointment booked for ${pet.name}.`,
			appointment.id,
		);

		return this.finish(
			conversation,
			`You're all set—${pet.name}'s ${service.name} is booked for ${formatLocalDateTime(
				appointment.startAt,
				this.business.timezone,
			)}.`,
			outcome,
		);
	}

	private async rescheduleAppointment(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): Promise<ConversationResponse> {
		const identity = this.getAppointmentIdentity(interpretedMessage, conversation);
		if (!identity) {
			return this.askForMissingAppointmentIdentity(interpretedMessage, conversation);
		}

		const lookup = await this.findAppointment(identity, interpretedMessage, conversation);
		if (lookup.response) return lookup.response;
		if (!lookup.appointment) {
			return this.ask(conversation, "I could not find a unique appointment to reschedule.");
		}

		if (!interpretedMessage.requestedDate) {
			return this.ask(
				conversation,
				"What new date would you like for the appointment?",
				"requested_date",
			);
		}

		if (!interpretedMessage.requestedTime) {
			return this.ask(
				conversation,
				"What time would you like on that date?",
				"requested_time",
			);
		}

		const durationMinutes = this.getDurationMinutes(lookup.appointment);
		const slot = this.createRequestedSlot(
			interpretedMessage.requestedDate,
			interpretedMessage.requestedTime,
			durationMinutes,
		);

		if (interpretedMessage.confirmation !== true) {
			const appointmentTime = formatLocalDateTime(slot.startAt, this.business.timezone);
			return this.ask(
				conversation,
				`I found ${lookup.appointment.petName}'s appointment. Would you like me to move it to ${appointmentTime}?`,
				"appointment_confirmation",
			);
		}

		const request: RescheduleAppointmentRequest = {
			...identity,
			appointmentId: lookup.appointment.id,
			newStartAt: slot.startAt,
			newEndAt: slot.endAt,
			confirmed: true,
		};
		const appointment = await this.dependencies.management.reschedule(request);
		const outcome = createConversationOutcome(
			"completed",
			`Appointment rescheduled for ${lookup.appointment.petName}.`,
			appointment.id,
		);

		return this.finish(
			conversation,
			`The appointment is now scheduled for ${formatLocalDateTime(
				appointment.startAt,
				this.business.timezone,
			)}.`,
			outcome,
		);
	}

	private async cancelAppointment(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): Promise<ConversationResponse> {
		const identity = this.getAppointmentIdentity(interpretedMessage, conversation);
		if (!identity) {
			return this.askForMissingAppointmentIdentity(interpretedMessage, conversation);
		}

		const lookup = await this.findAppointment(identity, interpretedMessage, conversation);
		if (lookup.response) return lookup.response;
		if (!lookup.appointment) {
			return this.ask(conversation, "I could not find a unique appointment to cancel.");
		}

		if (interpretedMessage.confirmation !== true) {
			return this.ask(
				conversation,
				`I found ${lookup.appointment.petName}'s appointment for ${formatLocalDateTime(
					lookup.appointment.startAt,
					this.business.timezone,
				)}. Would you like me to cancel it?`,
				"appointment_confirmation",
			);
		}

		const request: CancelAppointmentRequest = {
			...identity,
			appointmentId: lookup.appointment.id,
			confirmed: true,
		};
		await this.dependencies.management.cancel(request);
		const outcome = createConversationOutcome(
			"completed",
			`Appointment cancelled for ${lookup.appointment.petName}.`,
			lookup.appointment.id,
		);

		return this.finish(conversation, "The appointment has been cancelled.", outcome);
	}

	private async handleLateArrival(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): Promise<ConversationResponse> {
		const identity = this.getAppointmentIdentity(interpretedMessage, conversation);
		if (!identity) {
			return this.askForMissingAppointmentIdentity(interpretedMessage, conversation);
		}

		if (interpretedMessage.minutesLate === undefined) {
			return this.ask(
				conversation,
				"How many minutes late do you expect to be?",
				"minutes_late",
			);
		}

		const lookup = await this.findAppointment(identity, interpretedMessage, conversation);
		if (lookup.response) return lookup.response;
		if (!lookup.appointment) {
			return this.ask(
				conversation,
				"I could not find a unique appointment for the late-arrival notice.",
			);
		}

		const request: LateArrivalRequest = {
			...identity,
			appointment: lookup.appointment,
			petName: lookup.appointment.petName,
			minutesLate: interpretedMessage.minutesLate,
		};
		const result = await this.dependencies.support.handleLateArrival(request);

		return this.finishWithSupportResult(conversation, result);
	}

	private async handleComplaint(
		interpretedMessage: InterpretedMessage,
		message: string,
		conversation: Conversation,
	): Promise<ConversationResponse> {
		const contactPhone = this.getContactPhone(interpretedMessage, conversation);
		if (!contactPhone) {
			if (interpretedMessage.contactPhone) {
				return this.ask(
					conversation,
					`Please confirm that ${interpretedMessage.contactPhone} is the contact number for this complaint.`,
					"contact_phone_confirmation",
				);
			}

			return this.ask(
				conversation,
				"What contact phone number should I use for this complaint?",
				"contact_phone",
			);
		}

		if (!interpretedMessage.customerName) {
			return this.ask(
				conversation,
				"What customer name should I attach to this complaint?",
				"customer_name",
			);
		}

		if (!interpretedMessage.complaintCategory) {
			return this.ask(
				conversation,
				"What part of the experience would you like to report?",
				"complaint_category",
			);
		}

		const details = interpretedMessage.complaintDetails ?? message.trim();
		const appointment = await this.findComplaintAppointment(interpretedMessage, conversation);
		if (appointment.response) return appointment.response;

		const request: ComplaintRequest = {
			businessId: this.business.id,
			conversationId: conversation.id,
			contactPhone,
			customerName: interpretedMessage.customerName,
			category: interpretedMessage.complaintCategory,
			details,
			...(conversation.callerPhone ? { callerPhone: conversation.callerPhone } : {}),
			...(interpretedMessage.petName ? { petName: interpretedMessage.petName } : {}),
			...(appointment.appointment ? { appointment: appointment.appointment } : {}),
			...(interpretedMessage.disputedCharge
				? { disputedCharge: interpretedMessage.disputedCharge }
				: {}),
			...(interpretedMessage.resolution ? { resolution: interpretedMessage.resolution } : {}),
		};
		const result = await this.dependencies.support.recordComplaint(request);

		return this.finishWithSupportResult(conversation, result);
	}

	private async findComplaintAppointment(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): Promise<AppointmentLookup> {
		if (!interpretedMessage.appointmentId && !interpretedMessage.petName) {
			return {};
		}

		const identity = this.getAppointmentIdentity(interpretedMessage, conversation);
		if (!identity) {
			return {
				response: this.askForMissingAppointmentIdentity(interpretedMessage, conversation),
			};
		}

		return this.findAppointment(identity, interpretedMessage, conversation);
	}

	private async findAppointment(
		identity: AppointmentIdentityWithConversation,
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): Promise<AppointmentLookup> {
		const result = await this.dependencies.management.findAppointments(identity);
		const lookup = this.getAppointmentFromLookup(result, interpretedMessage.appointmentId);

		if (lookup.reason) {
			return { response: this.ask(conversation, lookup.reason) };
		}

		return lookup;
	}

	private getAppointmentIdentity(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): AppointmentIdentityWithConversation | undefined {
		const contactPhone = this.getContactPhone(interpretedMessage, conversation);
		if (!contactPhone || !interpretedMessage.customerName || !interpretedMessage.petName) {
			return undefined;
		}

		return {
			businessId: this.business.id,
			conversationId: conversation.id,
			contactPhone,
			customerName: interpretedMessage.customerName,
			petName: interpretedMessage.petName,
			...(conversation.callerPhone ? { callerPhone: conversation.callerPhone } : {}),
		};
	}

	private askForMissingAppointmentIdentity(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): ConversationResponse {
		const contactPhone = this.getContactPhone(interpretedMessage, conversation);

		if (!contactPhone) {
			if (interpretedMessage.contactPhone) {
				return this.ask(
					conversation,
					`Please confirm that ${interpretedMessage.contactPhone} is the contact number for the appointment.`,
					"contact_phone_confirmation",
				);
			}

			return this.ask(
				conversation,
				"What contact phone number is on the appointment?",
				"contact_phone",
			);
		}

		if (!interpretedMessage.customerName) {
			return this.ask(
				conversation,
				"What customer name is on the appointment?",
				"customer_name",
			);
		}

		return this.ask(conversation, "What is the pet's name on the appointment?", "pet_name");
	}

	private getContactPhone(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): string | undefined {
		if (conversation.contactPhone) return conversation.contactPhone;
		if (interpretedMessage.contactPhoneConfirmed) return interpretedMessage.contactPhone;
		return undefined;
	}

	private findService(
		message: InterpretedMessage,
	): { id: ServiceId; name: string; durationMinutes: number } | undefined {
		if (message.serviceId) {
			return this.business.services.find((service) => service.id === message.serviceId);
		}

		if (!message.serviceName) return undefined;

		const normalizedName = message.serviceName.trim().toLowerCase().replace(/\s+/g, "-");
		return this.business.services.find(
			(service) =>
				service.id === normalizedName ||
				service.name.toLowerCase() === message.serviceName?.toLowerCase(),
		);
	}

	private createRequestedSlot(
		requestedDate: string,
		requestedTime: string,
		durationMinutes: number,
	): AppointmentSlot {
		const startAt = localDateTimeToDate(requestedDate, requestedTime, this.business.timezone);
		const endAt = new Date(startAt.getTime() + durationMinutes * 60_000);
		return new AppointmentSlot(startAt.toISOString(), endAt.toISOString());
	}

	private getDurationMinutes(appointment: Appointment): number {
		const duration = (Date.parse(appointment.endAt) - Date.parse(appointment.startAt)) / 60_000;
		if (!Number.isFinite(duration) || duration <= 0) {
			throw new Error("Appointment has an invalid duration");
		}

		return duration;
	}

	private getAppointmentFromLookup(
		result: AppointmentLookupResult,
		requestedAppointmentId: string | undefined,
	): AppointmentLookup {
		if (result.status === "not_found") {
			return { reason: result.reason ?? "No appointment was found." };
		}

		if (result.status === "ambiguous") {
			return { reason: result.reason ?? "More than one appointment matches those details." };
		}

		const appointment = result.appointments[0];
		if (!appointment) {
			return { reason: "No appointment was found." };
		}

		if (requestedAppointmentId && requestedAppointmentId !== appointment.id) {
			return { reason: "The appointment ID does not match the confirmed customer and pet." };
		}

		return { appointment };
	}

	private ask(
		conversation: Conversation,
		reply: string,
		expectedCustomerField?: ExpectedCustomerField,
	): ConversationResponse {
		const response = this.finish(
			conversation,
			reply,
			createConversationOutcome("needs_information", reply),
		);

		if (expectedCustomerField) {
			conversation.expectCustomerField(expectedCustomerField);
		}

		return response;
	}

	private finishWithOutcome(
		conversation: Conversation,
		outcome: ConversationOutcome,
	): ConversationResponse {
		return this.finish(conversation, outcome.summary, outcome);
	}

	private finishWithSupportResult(
		conversation: Conversation,
		result: CustomerSupportResult,
	): ConversationResponse {
		return this.finish(conversation, result.reply, result.outcome);
	}

	private finish(
		conversation: Conversation,
		reply: string,
		outcome: ConversationOutcome,
	): ConversationResponse {
		if (outcome.status !== "needs_information") {
			conversation.clearExpectedCustomerField();
		}

		conversation.recordOutcome(outcome);
		conversation.addMessage("receptionist", reply);
		return { reply, outcome };
	}
}

function formatChoices(choices: readonly string[]): string {
	if (choices.length === 0) return "no services";
	if (choices.length === 1) return choices[0] ?? "";
	if (choices.length === 2) return `${choices[0]} or ${choices[1]}`;

	return `${choices.slice(0, -1).join(", ")}, or ${choices.at(-1)}`;
}
