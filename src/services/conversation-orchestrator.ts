import type { Appointment } from "../models/appointment.js";
import type { BusinessConfig, ServiceId } from "../models/business.js";
import type { Conversation } from "../models/conversation.js";
import type { PetDetails } from "../models/customer.js";
import {
	createConversationOutcome,
	type ConversationOutcome,
	type InterpretedMessage,
} from "../models/receptionist.js";
import { localDateTimeToDate } from "./calendar-time.js";
import {
	type AppointmentBookingRequest,
	type AppointmentBookingService,
} from "./appointment-booking.js";
import type {
	AppointmentIdentity,
	AppointmentLookupResult,
	AppointmentManagementService,
	CancelAppointmentRequest,
	RescheduleAppointmentRequest,
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
import type { MessageInterpreter } from "./receptionist-dependencies.js";

export interface ConversationResponse {
	reply: string;
	outcome: ConversationOutcome;
}

export interface ConversationMessageHandler {
	handleMessage(message: string, conversation: Conversation): Promise<ConversationResponse>;
}

export interface ConversationOrchestratorDependencies {
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
	) {}

	async handleMessage(
		message: string,
		conversation: Conversation,
	): Promise<ConversationResponse> {
		if (conversation.businessId !== this.business.id) {
			throw new Error("Conversation does not belong to the configured business");
		}

		let interpretedMessage: InterpretedMessage;

		try {
			interpretedMessage = await this.interpreter.interpret(
				message,
				this.business,
				conversation,
			);
		} catch (error) {
			const reason = error instanceof Error ? error.message : "Unknown error";
			console.error("Message interpretation failed.", reason);
			return this.finish(
				conversation,
				"I’m sorry, I could not safely understand that request. Could you rephrase it?",
				createConversationOutcome(
					"needs_information",
					"The customer message needs clarification before the receptionist can continue.",
				),
			);
		}

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
			console.error("Conversation action failed.", error);
			return this.finish(
				conversation,
				"I could not safely complete that request. I have recorded it for owner review.",
				createConversationOutcome(
					"needs_human",
					"The requested action could not be completed safely and requires owner review.",
				),
			);
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
					"Which contact phone number would you like to confirm?",
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

	private answerPricing(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): ConversationResponse {
		return this.finishWithOutcome(
			conversation,
			this.dependencies.information.answerPricing(
				interpretedMessage.serviceName ?? interpretedMessage.serviceId,
				interpretedMessage.weightLb,
			),
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
			return this.ask(
				conversation,
				"Before booking, please provide and explicitly confirm the contact phone number for the appointment.",
			);
		}

		if (!interpretedMessage.customerName) {
			return this.ask(conversation, "What name should I put on the appointment?");
		}

		const pet = this.createPetDetails(interpretedMessage);
		if (!pet) {
			return this.ask(
				conversation,
				"Please provide your dog's name, approximate weight, and rabies vaccination status.",
			);
		}

		const service = this.findService(interpretedMessage);
		if (!service) {
			return this.ask(
				conversation,
				"Which configured grooming service would you like to book?",
			);
		}

		const slot = this.createRequestedSlot(
			interpretedMessage,
			getAppointmentDuration(this.business, service.durationMinutes, pet.weightLb),
		);
		if (!slot) {
			return this.ask(
				conversation,
				"What date and time would you like for the appointment? Please use the shop's local time.",
			);
		}

		if (interpretedMessage.confirmation !== true) {
			return this.ask(
				conversation,
				`I can book ${service.name} for ${pet.name} at ${slot.startAt}. Please confirm these details to continue.`,
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
			`Your ${service.name} appointment for ${pet.name} is booked.`,
			outcome,
		);
	}

	private async rescheduleAppointment(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): Promise<ConversationResponse> {
		const identity = this.getAppointmentIdentity(interpretedMessage, conversation);
		if (!identity) {
			return this.ask(
				conversation,
				"To find the appointment, please confirm the contact phone, customer name, and pet name.",
			);
		}

		const lookup = await this.findAppointment(identity, interpretedMessage, conversation);
		if (lookup.response) return lookup.response;
		if (!lookup.appointment) {
			return this.ask(conversation, "I could not find a unique appointment to reschedule.");
		}

		const durationMinutes = this.getDurationMinutes(lookup.appointment);
		const slot = this.createRequestedSlot(interpretedMessage, durationMinutes);
		if (!slot) {
			return this.ask(
				conversation,
				"What new date and time would you like for the appointment? Please use the shop's local time.",
			);
		}

		if (interpretedMessage.confirmation !== true) {
			return this.ask(
				conversation,
				`I found ${lookup.appointment.petName}'s appointment. Please confirm moving it to ${slot.startAt}.`,
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
			`The appointment is rescheduled to ${appointment.startAt}.`,
			outcome,
		);
	}

	private async cancelAppointment(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): Promise<ConversationResponse> {
		const identity = this.getAppointmentIdentity(interpretedMessage, conversation);
		if (!identity) {
			return this.ask(
				conversation,
				"To find the appointment, please confirm the contact phone, customer name, and pet name.",
			);
		}

		const lookup = await this.findAppointment(identity, interpretedMessage, conversation);
		if (lookup.response) return lookup.response;
		if (!lookup.appointment) {
			return this.ask(conversation, "I could not find a unique appointment to cancel.");
		}

		if (interpretedMessage.confirmation !== true) {
			return this.ask(
				conversation,
				`I found ${lookup.appointment.petName}'s appointment at ${lookup.appointment.startAt}. Please confirm cancellation.`,
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
			return this.ask(
				conversation,
				"To find the appointment, please confirm the contact phone, customer name, and pet name.",
			);
		}

		if (interpretedMessage.minutesLate === undefined) {
			return this.ask(conversation, "How many minutes late do you expect to be?");
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
		if (!contactPhone || !interpretedMessage.customerName) {
			return this.ask(
				conversation,
				"To record the complaint, please confirm the contact phone and customer name.",
			);
		}

		if (!interpretedMessage.complaintCategory) {
			return this.ask(conversation, "What part of the experience would you like to report?");
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
				response: this.ask(
					conversation,
					"Please confirm the customer name and pet name so I can attach this complaint to the right appointment.",
				),
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

	private getContactPhone(
		interpretedMessage: InterpretedMessage,
		conversation: Conversation,
	): string | undefined {
		if (conversation.contactPhone) return conversation.contactPhone;
		if (interpretedMessage.contactPhoneConfirmed) return interpretedMessage.contactPhone;
		return undefined;
	}

	private createPetDetails(message: InterpretedMessage): PetDetails | undefined {
		if (
			!message.petName ||
			message.weightLb === undefined ||
			message.rabiesVaccinationStatus === undefined
		) {
			return undefined;
		}

		const pet: PetDetails = {
			name: message.petName,
			weightLb: message.weightLb,
			rabiesVaccinationStatus: message.rabiesVaccinationStatus,
		};

		if (message.breedOrMix) pet.breedOrMix = message.breedOrMix;
		if (message.healthConcerns) pet.healthConcerns = message.healthConcerns;
		if (message.behaviorConcerns) pet.behaviorConcerns = message.behaviorConcerns;

		return pet;
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
		message: InterpretedMessage,
		durationMinutes: number,
	): AppointmentSlot | undefined {
		if (message.requestedStartAt && message.requestedEndAt) {
			return new AppointmentSlot(message.requestedStartAt, message.requestedEndAt);
		}

		if (!message.requestedDate || !message.requestedTime) return undefined;

		const startAt = localDateTimeToDate(
			message.requestedDate,
			message.requestedTime,
			this.business.timezone,
		);
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

	private ask(conversation: Conversation, reply: string): ConversationResponse {
		return this.finish(
			conversation,
			reply,
			createConversationOutcome("needs_information", reply),
		);
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
		conversation.recordOutcome(outcome);
		conversation.addMessage("receptionist", reply);
		return { reply, outcome };
	}
}
