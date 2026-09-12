import { randomUUID } from "node:crypto";

import type {
	ConversationOutcome,
	ExpectedCustomerField,
	InterpretedMessage,
	ReceptionistIntent,
} from "./receptionist.js";
import { isValidPhoneNumber } from "./customer.js";

export interface ReceiveMessageInput {
	businessId: string;
	callerPhone?: string;
	message: string;
	conversationId: string | undefined;
}

export interface ConversationLookupInput {
	businessId: string;
	callerPhone?: string;
	conversationId: string;
}

export type EndConversationInput = ConversationLookupInput;

export type ConversationStatus = "active" | "ended";

export interface ConversationMessage {
	author: "customer" | "receptionist";
	text: string;
}

export interface ConversationDetails {
	id: string;
	businessId: string;
	callerPhone?: string;
	contactPhone?: string;
}

export class Conversation {
	readonly id: string;
	readonly businessId: string;
	private readonly messageHistory: ConversationMessage[] = [];
	private callerPhoneValue: string | undefined;
	private contactPhoneValue: string | undefined;
	private readonly intentHistory: ReceptionistIntent[] = [];
	private activeRequestValue: InterpretedMessage | undefined;
	private expectedCustomerFieldValue: ExpectedCustomerField | undefined;
	private outcomeValue: ConversationOutcome | undefined;
	private ownerHandoffNotifiedValue = false;
	private contactPersistedValue = false;
	private alternativeSlotsOfferedValue = false;
	private alternativeSlotsRejectedValue = false;
	private readonly startedAtValue: Date;
	private lastActivityAtValue: Date;
	private statusValue: ConversationStatus = "active";
	private readonly detailFailures = new Map<string, number>();

	recordDetailFailure(field: "contactPhone" | "customerName"): number {
		this.requireActive("retry a detail in");
		const attempts = (this.detailFailures.get(field) ?? 0) + 1;
		this.detailFailures.set(field, attempts);
		return attempts;
	}

	rejectContactPhone(): void {
		this.requireActive("reject a phone number in");
		this.contactPhoneValue = undefined;
		if (this.activeRequestValue) {
			delete this.activeRequestValue.contactPhone;
			delete this.activeRequestValue.contactPhoneConfirmed;
			delete this.activeRequestValue.confirmation;
		}
	}

	rejectCustomerName(): void {
		this.requireActive("reject a name in");
		if (this.activeRequestValue) {
			delete this.activeRequestValue.customerName;
			delete this.activeRequestValue.customerNameConfirmed;
			delete this.activeRequestValue.confirmation;
		}
	}

	constructor(details: ConversationDetails, lastActivityAt: Date = new Date()) {
		if (details.id.trim().length === 0 || details.businessId.trim().length === 0) {
			throw new InvalidConversationError("Conversation ID and business ID are required");
		}

		if (!Number.isFinite(lastActivityAt.getTime())) {
			throw new InvalidConversationError("Conversation activity time must be valid");
		}

		if (details.callerPhone !== undefined && !isValidPhoneNumber(details.callerPhone)) {
			throw new InvalidConversationError("Caller phone must use E.164 format");
		}

		if (details.contactPhone !== undefined && !isValidPhoneNumber(details.contactPhone)) {
			throw new InvalidConversationError("Contact phone must use E.164 format");
		}

		this.id = details.id;
		this.businessId = details.businessId;
		this.callerPhoneValue = details.callerPhone;
		this.contactPhoneValue = details.contactPhone;
		this.startedAtValue = new Date(lastActivityAt);
		this.lastActivityAtValue = new Date(lastActivityAt);
	}

	get callerPhone(): string | undefined {
		return this.callerPhoneValue;
	}

	get contactPhone(): string | undefined {
		return this.contactPhoneValue;
	}

	get messages(): readonly ConversationMessage[] {
		return this.messageHistory;
	}

	get intents(): readonly ReceptionistIntent[] {
		return this.intentHistory;
	}

	get activeRequest(): Readonly<InterpretedMessage> | undefined {
		return this.activeRequestValue;
	}

	get expectedCustomerField(): ExpectedCustomerField | undefined {
		return this.expectedCustomerFieldValue;
	}

	get outcome(): ConversationOutcome | undefined {
		return this.outcomeValue;
	}

	get status(): ConversationStatus {
		return this.statusValue;
	}

	get ownerHandoffNotified(): boolean {
		return this.ownerHandoffNotifiedValue;
	}

	get contactPersisted(): boolean {
		return this.contactPersistedValue;
	}

	get alternativeSlotsOffered(): boolean {
		return this.alternativeSlotsOfferedValue;
	}

	get alternativeSlotsRejected(): boolean {
		return this.alternativeSlotsRejectedValue;
	}

	get lastActivityAt(): Date {
		return new Date(this.lastActivityAtValue);
	}

	get startedAt(): Date {
		return new Date(this.startedAtValue);
	}

	associateCallerPhone(callerPhone: string): void {
		this.requireActive("associate a phone number with");

		if (!isValidPhoneNumber(callerPhone)) {
			throw new InvalidConversationError("Caller phone must use E.164 format");
		}

		if (this.callerPhoneValue && this.callerPhoneValue !== callerPhone) {
			throw new ConversationStateError("Conversation already belongs to another caller");
		}

		this.callerPhoneValue = callerPhone;
	}

	confirmContactPhone(contactPhone: string): void {
		this.requireActive("confirm a contact phone for");

		if (!isValidPhoneNumber(contactPhone)) {
			throw new InvalidConversationError("Contact phone must use E.164 format");
		}

		this.contactPhoneValue = contactPhone;
		this.detailFailures.delete("contactPhone");
	}

	addMessage(author: ConversationMessage["author"], text: string): void {
		this.requireActive("add a message to");
		const normalizedText = text.trim();

		if (normalizedText.length === 0) {
			throw new InvalidConversationError("Conversation message is required");
		}

		this.messageHistory.push({ author, text: normalizedText });
	}

	recordIntent(intent: ReceptionistIntent): void {
		this.requireActive("record an intent for");

		if (!this.intentHistory.includes(intent)) {
			this.intentHistory.push(intent);
		}
	}

	updateActiveRequest(interpretedMessage: InterpretedMessage): InterpretedMessage {
		this.requireActive("update the active request for");
		const requestFacts = { ...interpretedMessage };
		delete requestFacts.conversationAction;
		if (requestFacts.customerNameConfirmed === true) this.detailFailures.delete("customerName");

		const previousRequest = this.activeRequestValue;
		const continuesPreviousRequest =
			(previousRequest !== undefined &&
				requestFacts.intent === previousRequest.intent &&
				(this.outcomeValue?.status === "needs_information" ||
					previousRequest.intent === "pricing")) ||
			(requestFacts.intent === "unknown" &&
				this.outcomeValue?.status === "needs_information");

		if (previousRequest && continuesPreviousRequest) {
			const bookingFields = [
				"customerName",
				"contactPhone",
				"petName",
				"weightLb",
				"rabiesVaccinationStatus",
				"healthConcerns",
				"behaviorConcerns",
				"safetyConcern",
				"serviceId",
				"serviceName",
				"requestedDate",
				"requestedTime",
				"appointmentId",
			] as const;
			const detailsChanged = bookingFields.some(
				(field) =>
					requestFacts[field] !== undefined &&
					requestFacts[field] !== previousRequest[field],
			);
			if (
				requestFacts.contactPhone &&
				requestFacts.contactPhone !== previousRequest.contactPhone
			) {
				this.contactPhoneValue = undefined;
				previousRequest.contactPhoneConfirmed = false;
				requestFacts.contactPhoneConfirmed = false;
			}
			if (
				requestFacts.customerName &&
				requestFacts.customerName !== previousRequest.customerName
			) {
				previousRequest.customerNameConfirmed = false;
			}
			this.activeRequestValue = {
				...previousRequest,
				...requestFacts,
				intent:
					requestFacts.intent === "unknown"
						? previousRequest.intent
						: requestFacts.intent,
			};
			if (detailsChanged) delete this.activeRequestValue.confirmation;
		} else {
			this.activeRequestValue = requestFacts;
		}

		this.expectedCustomerFieldValue = undefined;
		return { ...this.activeRequestValue };
	}

	resetActiveRequest(): void {
		this.requireActive("reset the active request for");
		this.activeRequestValue = undefined;
		this.expectedCustomerFieldValue = undefined;
		this.outcomeValue = undefined;
		this.detailFailures.clear();
		this.alternativeSlotsOfferedValue = false;
		this.alternativeSlotsRejectedValue = false;
	}

	clearRequestedAppointmentSlot(): void {
		this.requireActive("clear the requested appointment slot for");

		if (this.activeRequestValue) {
			const requestWithoutSlot = { ...this.activeRequestValue };
			delete requestWithoutSlot.requestedDate;
			delete requestWithoutSlot.requestedTime;
			delete requestWithoutSlot.confirmation;
			this.activeRequestValue = requestWithoutSlot;
		}

		this.expectedCustomerFieldValue = undefined;
	}

	markAlternativeSlotsOffered(): void {
		this.requireActive("mark alternative slots for");
		this.alternativeSlotsOfferedValue = true;
		this.alternativeSlotsRejectedValue = false;
	}

	clearAlternativeSlotsOffered(): void {
		this.requireActive("clear alternative slots for");
		this.alternativeSlotsOfferedValue = false;
	}

	markAlternativeSlotsRejected(): void {
		this.requireActive("mark alternative slots as rejected for");
		this.alternativeSlotsOfferedValue = false;
		this.alternativeSlotsRejectedValue = true;
	}

	clearAlternativeSlotsRejected(): void {
		this.requireActive("clear rejected alternative slots for");
		this.alternativeSlotsRejectedValue = false;
	}

	expectCustomerField(field: ExpectedCustomerField): void {
		this.requireActive("set the expected customer field for");
		this.expectedCustomerFieldValue = field;
	}

	clearExpectedCustomerField(): void {
		this.requireActive("clear the expected customer field for");
		this.expectedCustomerFieldValue = undefined;
	}

	markOwnerHandoffNotified(): void {
		this.requireActive("mark the owner handoff for");
		this.ownerHandoffNotifiedValue = true;
	}

	markContactPersisted(): void {
		this.requireActive("mark the contact as persisted for");
		this.contactPersistedValue = true;
	}

	markActivity(activityAt: Date): void {
		this.requireActive("record activity for");

		if (!Number.isFinite(activityAt.getTime())) {
			throw new InvalidConversationError("Conversation activity time must be valid");
		}

		this.lastActivityAtValue = new Date(activityAt);
	}

	isInactive(now: Date, idleTimeoutMs: number): boolean {
		if (!Number.isFinite(now.getTime())) {
			throw new InvalidConversationError("Conversation activity time must be valid");
		}

		if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) {
			throw new InvalidConversationError("Conversation idle timeout must be positive");
		}

		return now.getTime() - this.lastActivityAtValue.getTime() >= idleTimeoutMs;
	}

	recordOutcome(outcome: ConversationOutcome): void {
		this.requireActive("record an outcome for");
		this.outcomeValue = outcome;
	}

	end(): void {
		this.requireActive("end");
		this.statusValue = "ended";
	}

	private requireActive(action: string): void {
		if (this.statusValue !== "active") {
			throw new ConversationStateError(`Cannot ${action} an ended conversation`);
		}
	}
}

export class ConversationNotFoundError extends Error {}

export class InvalidConversationError extends Error {}

export class ConversationStateError extends Error {}

export class InMemoryConversationStore {
	private readonly conversations = new Map<string, Conversation>();
	private readonly endedConversationIds = new Set<string>();

	constructor(private readonly clock: () => Date = () => new Date()) {}

	// Start a conversation for a new ID, or append to the existing conversation.
	receiveMessage(input: ReceiveMessageInput): string {
		let conversationId = input.conversationId;

		if (!conversationId) {
			conversationId = randomUUID();
		}

		if (this.endedConversationIds.has(conversationId)) {
			throw new ConversationNotFoundError("Conversation not found");
		}

		if (this.conversations.has(conversationId)) {
			return this.appendMessage(input, conversationId);
		}

		const conversationDetails: ConversationDetails = {
			id: conversationId,
			businessId: input.businessId,
		};

		if (input.callerPhone !== undefined) {
			conversationDetails.callerPhone = input.callerPhone;
		}

		const conversation = new Conversation(conversationDetails, this.clock());
		conversation.addMessage("customer", input.message);
		this.conversations.set(conversationId, conversation);

		return conversationId;
	}

	// remove the in-memory conversation after the call ends.
	endConversation(input: EndConversationInput): void {
		const conversation = this.getConversation(input);
		conversation.end();
		this.conversations.delete(input.conversationId);
		this.endedConversationIds.add(input.conversationId);
	}

	getConversation(input: ConversationLookupInput): Conversation {
		const conversation = this.conversations.get(input.conversationId);

		if (!conversation || conversation.businessId !== input.businessId) {
			throw new ConversationNotFoundError("Conversation not found");
		}

		if (conversation.callerPhone !== undefined) {
			if (conversation.callerPhone !== input.callerPhone) {
				throw new ConversationNotFoundError("Conversation not found");
			}
		} else if (input.callerPhone !== undefined) {
			conversation.associateCallerPhone(input.callerPhone);
		}

		return conversation;
	}

	// Append each message received after the conversation starts.
	private appendMessage(input: ReceiveMessageInput, conversationId: string): string {
		const lookupInput: ConversationLookupInput = {
			businessId: input.businessId,
			conversationId,
		};

		if (input.callerPhone !== undefined) {
			lookupInput.callerPhone = input.callerPhone;
		}

		const conversation = this.getConversation(lookupInput);

		conversation.addMessage("customer", input.message);
		conversation.markActivity(this.clock());
		return conversation.id;
	}

	getInactiveConversations(
		idleTimeoutMs: number,
		now: Date = this.clock(),
	): readonly Conversation[] {
		return [...this.conversations.values()].filter((conversation) =>
			conversation.isInactive(now, idleTimeoutMs),
		);
	}
}
