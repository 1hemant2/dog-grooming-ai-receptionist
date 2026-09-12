import type { BusinessConfig } from "../models/business.js";
import { isValidPhoneNumber } from "../models/customer.js";

const DEFAULT_PORT = 3000;
const DEFAULT_BUSINESS_ID = "maple-street-dog-grooming";
const DEFAULT_SPREADSHEET_ID = DEFAULT_BUSINESS_ID;
const DEFAULT_CALENDAR_ID = DEFAULT_BUSINESS_ID;
const DEFAULT_GEMINI_MODEL = "gemini-3.5-flash";
const DEFAULT_LIVEKIT_AGENT_NAME = "maple-street-receptionist";

export const EXT = {
	googleapis: {
		baseUrl: "https://www.googleapis.com",
		paths: {
			sheetsScope: "/auth/spreadsheets",
			calendarScope: "/auth/calendar.events",
		},
	},
	telegram: {
		baseUrl: "https://api.telegram.org",
		paths: {
			sendMessage: "/sendMessage",
		},
	},
	googleSheets: {
		contacts: {
			headers: ["contactPhone", "customerName", "pets", "notes", "lastContactAt"],
			columns: {
				contactPhone: 0,
				customerName: 1,
				pets: 2,
				notes: 3,
				lastContactAt: 4,
			},
		},
		callLog: {
			headers: [
				"businessId",
				"conversationId",
				"startedAt",
				"endedAt",
				"callerPhone",
				"contactPhone",
				"intents",
				"outcomeStatus",
				"outcomeSummary",
				"callbackRequested",
				"appointmentId",
			],
			columns: {
				// Zero-based position of conversationId in a Call Log row (column B).
				conversationId: 1,
			},
		},
	},
};

export const APPLICATION_CONFIG = {
	port: getPort(),
	maxRequestBytes: 16_384,
	maxMessageCharacters: 4_000,
	maxConversationIdCharacters: 128,
	externalRequestTimeoutMs: 30_000,
	interpreterHistoryMessageLimit: 6,
	interpreterMaxOutputTokens: 300,
	outcomeSummaryHistoryMessageLimit: 12,
	outcomeSummaryMaxOutputTokens: 80,
	conversationIdleTimeoutMs: 15 * 60 * 1_000,
	conversationCleanupIntervalMs: 60 * 1_000,
};

export const APPLICATION_PATTERNS = {
	// Matches identifiers accepted by the in-memory conversation store and trusted voice providers.
	conversationId: /^[a-zA-Z0-9_-]+$/,
	// Matches a 24-hour time in HH:mm format, from 00:00 through 23:59.
	time24Hour: /^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/,
	// Matches explicit customer commands that clear the current request.
	conversationReset:
		/^(?:(?:please|can we|i want to|i would like to|let s|lets)\s+)?(?:reset(?:\s+in between|\s+(?:the|this|that|current|my)\s+(?:request|booking|conversation|flow))?|start over|start again|begin again|(?:new|start a new) (?:request|conversation)|forget this|forget that|cancel (?:this|that) and start(?: over| again))$/i,
	// Matches an explicit request to end the current call or conversation.
	conversationEnd:
		/^(?:(?:okay|ok|alright|well|thanks|thank you|please|can you|could you)\s+)*(?:goodbye|bye|i am done|im done|i m done|thats all|that s all|that is all|(?:i do not|i don t|i dont) want to continue(?:\s+(?:the|this)\s+(?:call|conversation))?|end (?:the|this) (?:call|conversation)|hang up|disconnect(?: the call)?|stop (?:the|this) (?:call|conversation)|we can end(?: now| here)?)(?:\s+(?:please|now|thanks|thank you))*$/i,
};

export interface VapiBusinessPhoneMapping {
	businessId: string;
	phoneNumber: string;
}

export interface VapiConfig {
	serverToken: string;
	businessPhoneMappings: VapiBusinessPhoneMapping[];
}

export interface LiveKitConfig {
	websocketUrl: string;
	host: string;
	apiKey: string;
	apiSecret: string;
	agentName: string;
}

// Store business configurations in an array so new vendors can be added without changing request handling.
export const BUSINESS_CONFIGS: BusinessConfig[] = [
	{
		id: DEFAULT_BUSINESS_ID,
		name: "Maple Street Dog Grooming",
		timezone: "Asia/Calcutta",
		phone: {
			countryCallingCode: "91",
			nationalNumberDigits: 10,
		},
		openingTime: "09:00",
		closingTime: "17:00",
		closedDays: ["Sunday"],
		rabiesVaccinationRequired: true,
		rabiesVaccinationGuidance: "Current rabies vaccination proof is required before grooming.",
		groomerCapacity: 1, // Maximum number of appointments that can run at the same time.
		rescheduleNoticeHours: 24, // Minimum notice required for automatic cancellation or rescheduling.
		lateHandoffMinutes: 15, // Delays at or above this threshold require human review.
		largeDogMinimumWeightLb: 71, // Dogs at or above this weight need extra appointment time.
		humanReviewWeightLb: 100, // Dogs above this weight require human review.
		largeDogExtraMinutes: 30, // Extra appointment time for dogs from 71 through 100 lb.
		availabilitySearchDays: 7, // Number of days checked when searching for an appointment.
		availabilitySlotIncrementMinutes: 30, // Candidate appointment start-time increment.
		sheets: {
			spreadsheetId: getSpreadsheetId(),
			contactsTabName: "Contacts",
			callLogTabName: "Call Log",
		},
		calendar: {
			calendarId: getCalendarId(),
		},
		services: [
			{
				id: "bath",
				name: "Bath",
				durationMinutes: 60,
				startingPriceDollars: 45,
				includedItems: [
					"shampoo and conditioner",
					"blow-drying",
					"brushing",
					"ear cleaning",
					"a nail trim",
				],
			},
			{
				id: "bath-and-trim",
				name: "Bath and Trim",
				durationMinutes: 90,
				startingPriceDollars: 70,
				includedItems: [
					"shampoo and conditioner",
					"blow-drying",
					"brushing",
					"ear cleaning",
					"a nail trim",
					"light trimming around the face, feet, and sanitary areas",
				],
			},
			{
				id: "full-groom",
				name: "Full Groom",
				durationMinutes: 120,
				startingPriceDollars: 95,
				includedItems: [
					"shampoo and conditioner",
					"blow-drying",
					"brushing",
					"ear cleaning",
					"a nail trim",
					"a complete haircut and style",
				],
			},
		],
	},
];

// Find the configuration for the requested business.
export function findBusinessConfig(businessId: string): BusinessConfig | undefined {
	for (const businessConfig of BUSINESS_CONFIGS) {
		if (businessConfig.id === businessId) {
			return businessConfig;
		}
	}

	return undefined;
}

export function getVapiConfig(
	environment: Record<string, string | undefined> = process.env,
): VapiConfig | undefined {
	const serverToken = environment.VAPI_SERVER_TOKEN?.trim();
	const phoneNumber = environment.VAPI_PHONE_NUMBER?.trim();
	const businessId = environment.VAPI_BUSINESS_ID?.trim() || DEFAULT_BUSINESS_ID;

	if (!serverToken && !phoneNumber) {
		return undefined;
	}

	if (!serverToken || !phoneNumber) {
		throw new Error("VAPI_SERVER_TOKEN and VAPI_PHONE_NUMBER must be configured together");
	}

	if (!isValidPhoneNumber(phoneNumber)) {
		throw new Error("VAPI_PHONE_NUMBER must use E.164 format");
	}

	if (!findBusinessConfig(businessId)) {
		throw new Error(`VAPI_BUSINESS_ID references an unknown business: ${businessId}`);
	}

	return {
		serverToken,
		businessPhoneMappings: [{ businessId, phoneNumber }],
	};
}

export function getLiveKitConfig(
	environment: Record<string, string | undefined> = process.env,
): LiveKitConfig | undefined {
	const rawUrl = environment.LIVEKIT_URL?.trim();
	const apiKey = environment.LIVEKIT_API_KEY?.trim();
	const apiSecret = environment.LIVEKIT_API_SECRET?.trim();

	if (!rawUrl && !apiKey && !apiSecret) {
		return undefined;
	}

	if (!rawUrl || !apiKey || !apiSecret) {
		throw new Error(
			"LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be configured together",
		);
	}

	const liveKitUrls = parseLiveKitUrls(rawUrl);

	return {
		websocketUrl: liveKitUrls.websocketUrl,
		host: liveKitUrls.host,
		apiKey,
		apiSecret,
		agentName: environment.LIVEKIT_AGENT_NAME?.trim() || DEFAULT_LIVEKIT_AGENT_NAME,
	};
}

function getPort(): number {
	const port = Number(process.env.PORT ?? DEFAULT_PORT);

	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("PORT must be an integer between 1 and 65535");
	}

	return port;
}

function parseLiveKitUrls(rawUrl: string): { websocketUrl: string; host: string } {
	let parsedUrl: URL;

	try {
		parsedUrl = new URL(rawUrl);
	} catch {
		throw new Error("LIVEKIT_URL must be a valid LiveKit URL");
	}

	if (!["http:", "https:", "ws:", "wss:"].includes(parsedUrl.protocol)) {
		throw new Error("LIVEKIT_URL must use http, https, ws, or wss");
	}

	const websocketUrl = new URL(parsedUrl);
	websocketUrl.protocol =
		parsedUrl.protocol === "http:" || parsedUrl.protocol === "ws:" ? "ws:" : "wss:";

	const host = new URL(parsedUrl);
	host.protocol =
		parsedUrl.protocol === "http:" || parsedUrl.protocol === "ws:" ? "http:" : "https:";

	return {
		websocketUrl: websocketUrl.toString().replace(/\/$/, ""),
		host: host.toString().replace(/\/$/, ""),
	};
}

export function getGoogleServiceAccountCredentials(): {
	clientEmail: string;
	privateKey: string;
} {
	const clientEmail = process.env.GOOGLE_CLIENT_EMAIL?.trim();
	const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n").trim();

	if (!clientEmail || !privateKey) {
		throw new Error("GOOGLE_CLIENT_EMAIL and GOOGLE_PRIVATE_KEY are required");
	}

	return { clientEmail, privateKey };
}

export function getTelegramOwnerNotificationConfig(): {
	botToken: string;
	chatId: string;
} {
	const botToken = process.env.TELEGRAM_BOT_TOKEN?.trim();
	const chatId = process.env.TELEGRAM_CHAT_ID?.trim();

	if (!botToken || !chatId) {
		throw new Error("TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are required");
	}

	return { botToken, chatId };
}

export function getGeminiConfig(): { apiKey: string; model: string } {
	const apiKey = process.env.GEMINI_API_KEY?.trim();
	const model = process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;

	if (!apiKey) {
		throw new Error("GEMINI_API_KEY is required");
	}

	return { apiKey, model };
}

function getSpreadsheetId(): string {
	return process.env.GOOGLE_SPREADSHEET_ID?.trim() || DEFAULT_SPREADSHEET_ID;
}

function getCalendarId(): string {
	return process.env.GOOGLE_CALENDAR_ID?.trim() || DEFAULT_CALENDAR_ID;
}
