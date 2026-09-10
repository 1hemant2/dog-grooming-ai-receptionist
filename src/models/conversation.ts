import { randomUUID } from "node:crypto";

import type { ConversationOutcome, ReceptionistIntent } from "./receptionist.js";
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
	private outcomeValue: ConversationOutcome | undefined;
	private statusValue: ConversationStatus = "active";

	constructor(details: ConversationDetails) {
		if (details.id.trim().length === 0 || details.businessId.trim().length === 0) {
			throw new InvalidConversationError("Conversation ID and business ID are required");
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

	get outcome(): ConversationOutcome | undefined {
		return this.outcomeValue;
	}

	get status(): ConversationStatus {
		return this.statusValue;
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

		const conversation = new Conversation(conversationDetails);
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
		return conversation.id;
	}
}
