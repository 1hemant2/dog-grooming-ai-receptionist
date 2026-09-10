/* global document, fetch, sessionStorage */

const BUSINESS_ID = "maple-street-dog-grooming";
const CONVERSATION_ID_KEY = "mapleStreetConversationId";
const CALLER_PHONE_KEY = "mapleStreetCallerPhone";

class ReceptionistDemo {
	constructor() {
		this.form = document.querySelector("#message-form");
		this.messageInput = document.querySelector("#message");
		this.callerPhoneInput = document.querySelector("#caller-phone");
		this.sendButton = document.querySelector("#send-message");
		this.newConversationButton = document.querySelector("#new-conversation");
		this.scenarioList = document.querySelector("#scenario-list");
		this.conversationLog = document.querySelector("#conversation-log");
		this.status = document.querySelector("#request-status");
		this.conversationIdLabel = document.querySelector("#conversation-id");
		this.conversationId = sessionStorage.getItem(CONVERSATION_ID_KEY);

		this.form.addEventListener("submit", this.sendMessage.bind(this));
		this.messageInput.addEventListener("keydown", this.handleMessageKeydown.bind(this));
		this.newConversationButton.addEventListener("click", this.startNewConversation.bind(this));
		this.scenarioList.addEventListener("click", this.selectScenario.bind(this));

		this.restoreSession();
	}

	restoreSession() {
		const callerPhone = sessionStorage.getItem(CALLER_PHONE_KEY);

		if (callerPhone) {
			this.callerPhoneInput.value = callerPhone;
		}

		if (this.conversationId) {
			this.callerPhoneInput.disabled = true;
			this.conversationIdLabel.textContent = `Conversation: ${this.conversationId}`;
		}
	}

	handleMessageKeydown(event) {
		if (event.key !== "Enter" || event.shiftKey || event.isComposing) {
			return;
		}

		event.preventDefault();

		if (!this.sendButton.disabled) {
			this.form.requestSubmit();
		}
	}

	async sendMessage(event) {
		event.preventDefault();

		const message = this.messageInput.value.trim();
		const callerPhone = this.callerPhoneInput.value.trim();

		if (!message) {
			return;
		}

		this.addMessage("Customer", message, "customer-message");
		this.messageInput.value = "";
		this.setLoading(true);

		try {
			const response = await fetch("/conversations/messages", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Business-Id": BUSINESS_ID,
				},
				body: JSON.stringify({
					message,
					...(callerPhone ? { callerPhone } : {}),
					...(this.conversationId ? { conversationId: this.conversationId } : {}),
				}),
			});
			const result = await response.json();

			if (!response.ok) {
				throw new Error(result.error || "The receptionist could not process the request.");
			}

			this.saveSession(result.conversationId, callerPhone);
			this.setStatus(result.status);
			this.addMessage(
				"Receptionist",
				result.reply,
				"receptionist-message",
				result.appointmentId ? `Appointment: ${result.appointmentId}` : "",
			);
		} catch (error) {
			this.setStatus("error");
			this.addMessage(
				"System",
				error instanceof Error ? error.message : "The request failed.",
				"system-message",
			);
		} finally {
			this.setLoading(false);
			this.messageInput.focus();
		}
	}

	saveSession(conversationId, callerPhone) {
		this.conversationId = conversationId;
		sessionStorage.setItem(CONVERSATION_ID_KEY, conversationId);
		this.conversationIdLabel.textContent = `Conversation: ${conversationId}`;

		if (callerPhone) {
			sessionStorage.setItem(CALLER_PHONE_KEY, callerPhone);
		}

		this.callerPhoneInput.disabled = Boolean(callerPhone);
	}

	startNewConversation() {
		this.conversationId = null;
		sessionStorage.removeItem(CONVERSATION_ID_KEY);
		sessionStorage.removeItem(CALLER_PHONE_KEY);
		this.callerPhoneInput.value = "";
		this.callerPhoneInput.disabled = false;
		this.conversationIdLabel.textContent = "A conversation ID will appear here.";
		this.status.textContent = "Ready";
		this.status.dataset.status = "ready";
		this.conversationLog.replaceChildren();
		this.addMessage(
			"Receptionist",
			"Hello! How can I help with your dog’s grooming today?",
			"receptionist-message",
		);
		this.messageInput.focus();
	}

	selectScenario(event) {
		const button = event.target.closest("button[data-prompt]");

		if (!button) {
			return;
		}

		this.messageInput.value = button.dataset.prompt;
		this.messageInput.focus();
	}

	addMessage(author, text, className, metadata = "") {
		const message = document.createElement("article");
		message.className = `message ${className}`;

		const authorLabel = document.createElement("p");
		authorLabel.className = "message-author";
		authorLabel.textContent = author;

		const body = document.createElement("p");
		body.textContent = text;

		message.append(authorLabel, body);

		if (metadata) {
			const metadataLabel = document.createElement("span");
			metadataLabel.className = "message-meta";
			metadataLabel.textContent = metadata;
			message.append(metadataLabel);
		}

		this.conversationLog.append(message);
		this.conversationLog.scrollTop = this.conversationLog.scrollHeight;
	}

	setLoading(isLoading) {
		this.sendButton.disabled = isLoading;
		this.messageInput.disabled = isLoading;
		this.form.setAttribute("aria-busy", String(isLoading));

		if (isLoading) {
			this.status.textContent = "Working";
			this.status.dataset.status = "working";
		}
	}

	setStatus(status) {
		this.status.textContent = status.replaceAll("_", " ");
		this.status.dataset.status = status;
	}
}

new ReceptionistDemo();
