import { BUSINESS_CONFIGS, getGeminiConfig } from "../config/constants.js";
import { CalendarAvailabilityService } from "../services/calendar-availability.js";
import { AppointmentBookingService } from "../services/appointment-booking.js";
import { AppointmentManagementService } from "../services/appointment-management.js";
import { BusinessInformationService } from "../services/business-information.js";
import {
	ConversationOrchestrator,
	type ConversationMessageHandler,
} from "../services/conversation-orchestrator.js";
import { CustomerSupportService } from "../services/customer-support.js";
import { GeminiMessageInterpreter } from "../services/gemini-message-interpreter.js";
import { GoogleCalendarClient } from "../services/google-calendar-client.js";
import { GoogleSheetsClient } from "../services/google-sheets-client.js";
import {
	GoogleSheetsCallLog,
	GoogleSheetsContacts,
} from "../services/google-sheets-persistence.js";
import { TelegramOwnerNotifier } from "../services/telegram-owner-notifier.js";

export function createConversationOrchestratorResolver(): (
	businessId: string,
) => ConversationMessageHandler | undefined {
	const geminiInterpreter = new GeminiMessageInterpreter(getGeminiConfig());
	const spreadsheetClient = new GoogleSheetsClient();
	const ownerNotifier = new TelegramOwnerNotifier();
	const orchestrators = new Map<string, ConversationOrchestrator>();

	for (const business of BUSINESS_CONFIGS) {
		const calendarClient = new GoogleCalendarClient(business);
		const availability = new CalendarAvailabilityService(business, calendarClient);
		const contacts = new GoogleSheetsContacts(business, spreadsheetClient);
		const callLog = new GoogleSheetsCallLog(business, spreadsheetClient);
		const information = new BusinessInformationService(business);
		const booking = new AppointmentBookingService(
			business,
			availability,
			calendarClient,
			contacts,
		);
		const management = new AppointmentManagementService(
			business,
			calendarClient,
			availability,
			contacts,
			ownerNotifier,
		);
		const support = new CustomerSupportService(business, contacts, ownerNotifier);

		orchestrators.set(
			business.id,
			new ConversationOrchestrator(business, geminiInterpreter, {
				callLog,
				information,
				booking,
				availability,
				management,
				support,
				ownerNotifier,
				contacts,
			}),
		);
	}

	return (businessId: string) => orchestrators.get(businessId);
}
