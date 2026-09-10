import type { Appointment } from "../models/appointment.js";
import type { BusinessConfig } from "../models/business.js";
import { isValidPhoneNumber } from "../models/customer.js";
import { createConversationOutcome, type ConversationOutcome } from "../models/receptionist.js";
import type {
	CallLog,
	ContactRecord,
	Contacts,
	OwnerNotifier,
} from "./receptionist-dependencies.js";

export type ComplaintCategory =
	| "operational"
	| "refund_or_charge"
	| "grooming_quality"
	| "safety"
	| "injury"
	| "aggressive_behavior"
	| "compensation"
	| "other";

interface CustomerSupportRequest {
	businessId: string;
	conversationId: string;
	callerPhone?: string;
	contactPhone: string;
	customerName: string;
}

export interface LateArrivalRequest extends CustomerSupportRequest {
	petName: string;
	appointment: Appointment;
	minutesLate: number;
}

export interface ComplaintRequest extends CustomerSupportRequest {
	petName?: string;
	appointment?: Appointment;
	category: ComplaintCategory;
	details: string;
	disputedCharge?: string;
	resolution?: string;
}

export interface CustomerSupportResult {
	reply: string;
	outcome: ConversationOutcome;
}

export class CustomerSupportError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
	}
}

export class InvalidCustomerSupportRequestError extends CustomerSupportError {}

export class CustomerSupportIdentityError extends CustomerSupportError {}

export class CustomerSupportPersistenceError extends CustomerSupportError {}

export class CustomerSupportNotificationError extends CustomerSupportError {}

export class CustomerSupportService {
	constructor(
		private readonly business: BusinessConfig,
		private readonly contacts: Contacts,
		private readonly callLog: CallLog,
		private readonly ownerNotifier: OwnerNotifier,
		private readonly clock: () => Date = () => new Date(),
	) {}

	// Notify owner if customer is running late
	async handleLateArrival(request: LateArrivalRequest): Promise<CustomerSupportResult> {
		this.validateLateArrivalRequest(request);
		const contact = await this.confirmCustomer(request, request.petName, request.appointment);
		const needsHuman = request.minutesLate >= this.business.lateHandoffMinutes;
		const summary = createLateArrivalSummary(request, needsHuman);
		const outcome = createConversationOutcome(
			needsHuman ? "needs_human" : "completed",
			summary,
			request.appointment.id,
		);
		const reply = needsHuman
			? `Because the delay is ${request.minutesLate} minutes, I have sent the details to the owner for review. They will call you back.`
			: `I have kept the appointment and notified the owner that you expect to arrive ${request.minutesLate} minutes late.`;

		await this.recordSupportEvent(request, contact, outcome, "running_late", summary, true);

		return { reply, outcome };
	}

	//if complains are related to refund or safety concern let human handle it, else agent can handle it.
	async recordComplaint(request: ComplaintRequest): Promise<CustomerSupportResult> {
		this.validateComplaintRequest(request);
		const appointmentPetName = request.appointment?.petName;
		const petName = request.petName ?? appointmentPetName;
		const contact = await this.confirmCustomer(request, petName, request.appointment);
		const correctiveGroomNote = this.getCorrectiveGroomNote(request);
		const handledByAgent = request.category === "operational";
		const summary = createComplaintSummary(request, correctiveGroomNote, handledByAgent);
		const outcome = createConversationOutcome(
			handledByAgent ? "completed" : "needs_human",
			summary,
			request.appointment?.id,
		);
		const reply = createComplaintReply(request.category, request.resolution);

		await this.recordSupportEvent(
			request,
			contact,
			outcome,
			"complaint",
			summary,
			!handledByAgent,
		);

		return { reply, outcome };
	}

	//varify client appoint exist in our system.
	private async confirmCustomer(
		request: CustomerSupportRequest,
		petName: string | undefined,
		appointment: Appointment | undefined,
	): Promise<ContactRecord> {
		let contact: ContactRecord | undefined;

		try {
			contact = await this.contacts.findByContactPhone(
				request.businessId,
				request.contactPhone,
			);
		} catch (error) {
			throw new CustomerSupportPersistenceError("Contact lookup failed", { cause: error });
		}

		if (
			!contact ||
			contact.businessId !== this.business.id ||
			contact.customer.contactPhone !== request.contactPhone
		) {
			throw new CustomerSupportIdentityError("The customer could not be confirmed");
		}

		if (
			contact.customer.name?.trim().toLowerCase() !==
			request.customerName.trim().toLowerCase()
		) {
			throw new CustomerSupportIdentityError("The customer name could not be confirmed");
		}

		if (petName) {
			const matchingPet = contact.pets.some(
				(pet) => pet.name.trim().toLowerCase() === petName.trim().toLowerCase(),
			);

			if (!matchingPet) {
				throw new CustomerSupportIdentityError("The pet could not be confirmed");
			}
		}

		if (appointment) {
			const appointmentMatchesRequest =
				appointment.businessId === request.businessId &&
				appointment.contactPhone === request.contactPhone &&
				(!petName ||
					appointment.petName.trim().toLowerCase() === petName.trim().toLowerCase());

			if (!appointmentMatchesRequest) {
				throw new CustomerSupportIdentityError(
					"The appointment does not match the confirmed customer",
				);
			}
		}

		return contact;
	}

	// record customer support events in contact and call logs
	private async recordSupportEvent(
		request: CustomerSupportRequest,
		contact: ContactRecord,
		outcome: ConversationOutcome,
		intent: "running_late" | "complaint",
		summary: string,
		notifyOwner: boolean,
	): Promise<void> {
		const endedAt = this.clock().toISOString();
		const contactNote = `${endedAt}: ${summary}`;

		try {
			await this.contacts.save({
				...contact,
				lastContactAt: endedAt,
				notes: appendNote(contact.notes, contactNote),
			});
			await this.callLog.append({
				businessId: request.businessId,
				conversationId: request.conversationId,
				intent,
				contactPhone: request.contactPhone,
				outcome,
				endedAt,
				...(request.callerPhone ? { callerPhone: request.callerPhone } : {}),
			});
		} catch (error) {
			throw new CustomerSupportPersistenceError("Customer support event could not be saved", {
				cause: error,
			});
		}

		if (!notifyOwner) {
			return;
		}

		try {
			await this.ownerNotifier.notify(`${this.business.name}\n${summary}`);
		} catch (error) {
			throw new CustomerSupportNotificationError(
				"Customer support event was saved, but owner notification failed",
				{ cause: error },
			);
		}
	}

	private validateLateArrivalRequest(request: LateArrivalRequest): void {
		this.validateBaseRequest(request);

		if (request.petName.trim().length === 0) {
			throw new InvalidCustomerSupportRequestError("Pet name is required");
		}

		if (!Number.isInteger(request.minutesLate) || request.minutesLate < 0) {
			throw new InvalidCustomerSupportRequestError(
				"Minutes late must be a non-negative whole number",
			);
		}

		this.validateAppointment(request.appointment);
	}

	private validateComplaintRequest(request: ComplaintRequest): void {
		this.validateBaseRequest(request);

		if (request.petName !== undefined && request.petName.trim().length === 0) {
			throw new InvalidCustomerSupportRequestError("Pet name cannot be empty");
		}

		if (request.details.trim().length === 0) {
			throw new InvalidCustomerSupportRequestError("Complaint details are required");
		}

		if (request.category === "operational" && !request.resolution?.trim()) {
			throw new InvalidCustomerSupportRequestError(
				"A deterministic resolution is required for an operational complaint",
			);
		}

		if (request.category === "refund_or_charge") {
			if (!request.appointment) {
				throw new InvalidCustomerSupportRequestError(
					"An appointment is required for a refund or charge complaint",
				);
			}

			if (!request.disputedCharge?.trim()) {
				throw new InvalidCustomerSupportRequestError(
					"The disputed charge is required for a refund or charge complaint",
				);
			}
		}

		if (request.appointment) {
			this.validateAppointment(request.appointment);
		}
	}

	private validateBaseRequest(request: CustomerSupportRequest): void {
		if (request.businessId !== this.business.id) {
			throw new InvalidCustomerSupportRequestError(
				"Business does not match the configured business",
			);
		}

		if (request.conversationId.trim().length === 0) {
			throw new InvalidCustomerSupportRequestError("Conversation ID is required");
		}

		if (!isValidPhoneNumber(request.contactPhone)) {
			throw new InvalidCustomerSupportRequestError("Contact phone must use E.164 format");
		}

		if (request.customerName.trim().length === 0) {
			throw new InvalidCustomerSupportRequestError("Customer name is required");
		}

		if (request.callerPhone !== undefined && !isValidPhoneNumber(request.callerPhone)) {
			throw new InvalidCustomerSupportRequestError("Caller phone must use E.164 format");
		}
	}

	private validateAppointment(appointment: Appointment): void {
		if (appointment.id.trim().length === 0) {
			throw new InvalidCustomerSupportRequestError("Appointment ID is required");
		}
	}

	//human may review quality complain not graunted.
	private getCorrectiveGroomNote(request: ComplaintRequest): string | undefined {
		if (request.category !== "grooming_quality" || !request.appointment) {
			return undefined;
		}

		const appointmentEnd = Date.parse(request.appointment.endAt);
		const reportedAt = this.clock().getTime();
		const fortyEightHours = 48 * 60 * 60 * 1000;

		if (
			Number.isFinite(appointmentEnd) &&
			reportedAt >= appointmentEnd &&
			reportedAt <= appointmentEnd + fortyEightHours
		) {
			return "A human may review whether a corrective groom is appropriate.";
		}

		return undefined;
	}
}

function createLateArrivalSummary(request: LateArrivalRequest, needsHuman: boolean): string {
	const appointmentDescription = `${request.petName}'s appointment ${request.appointment.id} at ${request.appointment.startAt}`;

	if (needsHuman) {
		return `Customer ${request.customerName} expects to arrive ${request.minutesLate} minutes late for ${appointmentDescription}. Owner review and callback are required.`;
	}

	return `Customer ${request.customerName} expects to arrive ${request.minutesLate} minutes late for ${appointmentDescription}. The appointment remains scheduled.`;
}

function createComplaintSummary(
	request: ComplaintRequest,
	correctiveGroomNote: string | undefined,
	handledByAgent: boolean,
): string {
	const appointmentReference = request.appointment
		? ` Appointment: ${request.appointment.id}.`
		: "";
	const disputedCharge = request.disputedCharge
		? ` Disputed charge: ${request.disputedCharge.trim()}.`
		: "";
	const correctiveNote = correctiveGroomNote ? ` ${correctiveGroomNote}` : "";
	const resolution = request.resolution ? ` Resolution: ${request.resolution.trim()}.` : "";
	const followUp = handledByAgent
		? " The receptionist handled this operational concern."
		: " Human callback requested.";

	return `Customer ${request.customerName} reported a ${request.category} complaint.${appointmentReference}${disputedCharge} Details: ${request.details.trim()}.${resolution}${correctiveNote}${followUp}`;
}

function createComplaintReply(category: ComplaintCategory, resolution: string | undefined): string {
	if (category === "operational") {
		return `I understand your concern. ${resolution?.trim()} I have recorded it as resolved.`;
	}

	if (category === "refund_or_charge") {
		return "I have recorded your concern and sent it to the owner. The owner will call you back to review the charge. I cannot make refund or charge decisions here.";
	}

	if (
		category === "safety" ||
		category === "injury" ||
		category === "aggressive_behavior" ||
		category === "compensation"
	) {
		return "I have recorded this safety concern and sent it to the owner for immediate review. The owner will call you back.";
	}

	return "I have recorded your concern and sent it to the owner. The owner will call you back to discuss it.";
}

function appendNote(existingNotes: string | undefined, newNote: string): string {
	return existingNotes?.trim() ? `${existingNotes.trim()}\n${newNote}` : newNote;
}
