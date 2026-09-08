import { randomUUID } from "node:crypto";

export interface ReceiveMessageInput {
	businessId: string;
	callerPhone: string;
	message: string;
	conversationId: string | undefined;
}

export interface EndConversationInput {
	businessId: string;
	callerPhone: string;
	conversationId: string;
}

interface StoredConversation {
	id: string;
	businessId: string;
	callerPhone: string;
	messages: string[];
}

export class ConversationNotFoundError extends Error {}

export class InMemoryConversationStore {
	private readonly conversations = new Map<string, StoredConversation>();

	// Start a conversation for a new ID, or append to the existing conversation.
	receiveMessage(input: ReceiveMessageInput): string {
		let conversationId = input.conversationId;

		if (!conversationId) {
			conversationId = randomUUID();
		}

		if (this.conversations.has(conversationId)) {
			return this.appendMessage(input, conversationId);
		}

		this.conversations.set(conversationId, {
			id: conversationId,
			businessId: input.businessId,
			callerPhone: input.callerPhone,
			messages: [input.message],
		});

		return conversationId;
	}

	// Delete the in-memory conversation after the call ends.
	endConversation(input: EndConversationInput): void {
		this.getConversation(input.businessId, input.callerPhone, input.conversationId);
		this.conversations.delete(input.conversationId);
	}

	// Append each message received after the conversation starts.
	private appendMessage(input: ReceiveMessageInput, conversationId: string): string {
		const conversation = this.getConversation(
			input.businessId,
			input.callerPhone,
			conversationId,
		);

		conversation.messages.push(input.message);
		return conversation.id;
	}

	// Return the conversation only when it belongs to the specified vendor and caller.
	private getConversation(
		businessId: string,
		callerPhone: string,
		conversationId: string,
	): StoredConversation {
		const conversation = this.conversations.get(conversationId);

		if (
			!conversation ||
			conversation.businessId !== businessId ||
			conversation.callerPhone !== callerPhone
		) {
			throw new ConversationNotFoundError("Conversation not found");
		}

		return conversation;
	}
}
