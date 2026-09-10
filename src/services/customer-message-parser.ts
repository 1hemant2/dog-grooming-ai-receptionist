import { DateTime } from "luxon";

import { APPLICATION_PATTERNS } from "../config/constants.js";
import type { BusinessConfig, GroomingService } from "../models/business.js";
import type { Conversation } from "../models/conversation.js";
import type {
	ComplaintCategory,
	InterpretedMessage,
	ReceptionistIntent,
} from "../models/receptionist.js";
import { isValidPhoneNumber } from "../models/customer.js";

const MONTH_NUMBERS: Record<string, number> = {
	january: 1,
	jan: 1,
	february: 2,
	feb: 2,
	march: 3,
	mar: 3,
	april: 4,
	apr: 4,
	may: 5,
	june: 6,
	jun: 6,
	july: 7,
	jul: 7,
	august: 8,
	aug: 8,
	september: 9,
	sep: 9,
	sept: 9,
	october: 10,
	oct: 10,
	november: 11,
	nov: 11,
	december: 12,
	dec: 12,
};

const WEEKDAY_NUMBERS: Record<string, number> = {
	monday: 1,
	tuesday: 2,
	wednesday: 3,
	thursday: 4,
	friday: 5,
	saturday: 6,
	sunday: 7,
};

const MONTH_PATTERN = Object.keys(MONTH_NUMBERS).join("|");
const SERVICE_DETAILS_PATTERN =
	/\b(include|includes|included|including|contain|contains|details?|explain|come with|comes with)\b|\bwhat(?:'s| is| are)\b.*\bin\b/i;

export function isConversationResetRequest(message: string): boolean {
	return APPLICATION_PATTERNS.conversationReset.test(normalizeWords(message));
}

export function interpretExpectedAnswer(
	message: string,
	business: BusinessConfig,
	conversation: Conversation,
	currentLocalDate: DateTime,
): InterpretedMessage | undefined {
	const expectedField = conversation.expectedCustomerField;
	const activeIntent = conversation.activeRequest?.intent;

	if (!expectedField || !activeIntent) {
		return undefined;
	}

	switch (expectedField) {
		case "contact_phone": {
			const contactPhone = extractContactPhone(message, business);
			return contactPhone ? { intent: activeIntent, contactPhone } : undefined;
		}
		case "contact_phone_confirmation": {
			const confirmed = extractConfirmation(message);
			return confirmed === undefined
				? undefined
				: { intent: activeIntent, contactPhoneConfirmed: confirmed };
		}
		case "customer_name": {
			const customerName = extractName(message, ["my name is", "i am", "i'm"]);
			return customerName ? { intent: activeIntent, customerName } : undefined;
		}
		case "pet_name": {
			const petName = extractName(message, [
				"my dog's name is",
				"my dog is",
				"his name is",
				"her name is",
				"the pet's name is",
			]);
			return petName ? { intent: activeIntent, petName } : undefined;
		}
		case "dog_weight": {
			const weightLb = extractNumber(message);
			return weightLb ? { intent: activeIntent, weightLb } : undefined;
		}
		case "rabies_status": {
			const rabiesVaccinationStatus = extractRabiesStatus(message);
			return rabiesVaccinationStatus
				? { intent: activeIntent, rabiesVaccinationStatus }
				: undefined;
		}
		case "service": {
			const service = extractService(message, business);
			return service ? createServiceAnswer(activeIntent, service) : undefined;
		}
		case "requested_date": {
			const requestedDate = extractRequestedDate(
				message,
				business.timezone,
				currentLocalDate,
			);
			if (requestedDate) {
				const requestedTime = extractRequestedTime(message, true);
				return {
					intent: activeIntent,
					requestedDate,
					...(requestedTime ? { requestedTime } : {}),
				};
			}
			return isContinuationAcknowledgement(message) ? { intent: activeIntent } : undefined;
		}
		case "requested_time": {
			const requestedTime = extractRequestedTime(message, true);
			if (!requestedTime) return undefined;

			const requestedDate = extractRequestedDate(
				message,
				business.timezone,
				currentLocalDate,
			);
			return {
				intent: activeIntent,
				requestedTime,
				...(requestedDate ? { requestedDate } : {}),
			};
		}
		case "appointment_confirmation": {
			const confirmation = extractConfirmation(message);
			return confirmation === undefined ? undefined : { intent: activeIntent, confirmation };
		}
		case "minutes_late": {
			const minutesLate = extractNumber(message);
			return minutesLate === undefined ? undefined : { intent: activeIntent, minutesLate };
		}
		case "complaint_category": {
			const complaintCategory = extractComplaintCategory(message);
			return complaintCategory ? { intent: activeIntent, complaintCategory } : undefined;
		}
	}
}

export function applyFactsFromCustomerMessage(
	interpretedMessage: InterpretedMessage,
	message: string,
	business: BusinessConfig,
	currentLocalDate: DateTime,
): void {
	const contactPhone = extractContactPhone(message, business);
	if (contactPhone) interpretedMessage.contactPhone = contactPhone;

	const requestedDate = extractRequestedDate(message, business.timezone, currentLocalDate);
	if (requestedDate) interpretedMessage.requestedDate = requestedDate;

	const requestedTime = extractRequestedTime(message, false);
	if (requestedTime) interpretedMessage.requestedTime = requestedTime;

	const service = extractService(message, business);
	if (service) {
		interpretedMessage.serviceId = service.id;
		interpretedMessage.serviceName = service.name;
	}
}

export function interpretServiceDetailsQuestion(
	message: string,
	business: BusinessConfig,
): InterpretedMessage | undefined {
	if (!SERVICE_DETAILS_PATTERN.test(message)) return undefined;

	const service = extractService(message, business);
	return service ? createServiceAnswer("services", service) : undefined;
}

function createServiceAnswer(
	intent: ReceptionistIntent,
	service: GroomingService,
): InterpretedMessage {
	return {
		intent,
		serviceId: service.id,
		serviceName: service.name,
	};
}

function extractContactPhone(message: string, business: BusinessConfig): string | undefined {
	const candidates = message.match(/\+?[0-9][0-9\s().-]{7,}[0-9]/g) ?? [];

	for (const candidate of candidates) {
		const normalizedPhone = normalizeContactPhone(candidate, business);
		if (normalizedPhone) return normalizedPhone;
	}

	return undefined;
}

export function normalizeContactPhone(value: string, business: BusinessConfig): string | undefined {
	const compactPhone = value.replace(/[\s().-]/g, "");

	if (isValidPhoneNumber(compactPhone)) {
		return compactPhone;
	}

	if (!/^[0-9]+$/.test(compactPhone)) {
		return undefined;
	}

	const countryCode = business.phone.countryCallingCode;
	const nationalNumberDigits = business.phone.nationalNumberDigits;
	let normalizedPhone: string | undefined;

	if (compactPhone.length === nationalNumberDigits) {
		normalizedPhone = `+${countryCode}${compactPhone}`;
	} else if (
		compactPhone.startsWith(countryCode) &&
		compactPhone.length === countryCode.length + nationalNumberDigits
	) {
		normalizedPhone = `+${compactPhone}`;
	}

	return normalizedPhone && isValidPhoneNumber(normalizedPhone) ? normalizedPhone : undefined;
}

function extractName(message: string, prefixes: readonly string[]): string | undefined {
	let name = message.trim().replace(/[.!?]+$/g, "");
	const lowerCaseName = name.toLowerCase();

	for (const prefix of prefixes) {
		if (lowerCaseName.startsWith(`${prefix} `)) {
			name = name.slice(prefix.length).trim();
			break;
		}
	}

	if (!/^[A-Za-z][A-Za-z' -]{0,79}$/.test(name)) {
		return undefined;
	}

	const words = name.split(/\s+/);
	if (words.length > 4 || ["yes", "no", "confirm", "cancel"].includes(name.toLowerCase())) {
		return undefined;
	}

	return name;
}

function extractNumber(message: string): number | undefined {
	const match = message.match(/\b([0-9]+(?:\.[0-9]+)?)\b/);
	if (!match?.[1]) return undefined;

	const value = Number(match[1]);
	return Number.isFinite(value) && value >= 0 ? value : undefined;
}

function extractRabiesStatus(message: string): InterpretedMessage["rabiesVaccinationStatus"] {
	const normalizedMessage = message.trim().toLowerCase();

	if (/\b(yes|current|valid|up[ -]to[ -]date)\b/.test(normalizedMessage)) {
		return "current";
	}

	if (/\b(no|expired|out[ -]of[ -]date)\b/.test(normalizedMessage)) {
		return "expired";
	}

	if (/\b(unknown|unsure|not sure|don't know|do not know)\b/.test(normalizedMessage)) {
		return "unknown";
	}

	return undefined;
}

function extractService(message: string, business: BusinessConfig): GroomingService | undefined {
	const normalizedMessage = normalizeWords(message);

	for (const service of business.services) {
		if (
			normalizedMessage.includes(normalizeWords(service.name)) ||
			normalizedMessage.includes(normalizeWords(service.id))
		) {
			return service;
		}
	}

	return undefined;
}

function extractRequestedDate(
	message: string,
	timezone: string,
	currentLocalDate: DateTime,
): string | undefined {
	const relativeDate = extractRelativeDate(message, currentLocalDate);
	if (relativeDate) return relativeDate;

	const isoMatch = message.match(/\b([0-9]{4})-([0-9]{2})-([0-9]{2})\b/);
	if (isoMatch?.[1] && isoMatch[2] && isoMatch[3]) {
		return createRequestedDate(
			Number(isoMatch[1]),
			Number(isoMatch[2]),
			Number(isoMatch[3]),
			timezone,
		);
	}

	const normalizedMessage = message.toLowerCase().replace(/\b([0-9]{1,2})(st|nd|rd|th)\b/g, "$1");
	const dayFirst = normalizedMessage.match(
		new RegExp(`\\b([0-9]{1,2})\\s+(?:of\\s+)?(${MONTH_PATTERN})(?:\\s+([0-9]{4}))?\\b`, "i"),
	);
	const monthFirst = normalizedMessage.match(
		new RegExp(`\\b(${MONTH_PATTERN})\\s+([0-9]{1,2})(?:,?\\s+([0-9]{4}))?\\b`, "i"),
	);

	const dayText = dayFirst?.[1] ?? monthFirst?.[2];
	const monthText = dayFirst?.[2] ?? monthFirst?.[1];
	const yearText = dayFirst?.[3] ?? monthFirst?.[3];
	if (!dayText || !monthText) return undefined;

	const month = MONTH_NUMBERS[monthText.toLowerCase()];
	if (!month) return undefined;

	let year = yearText ? Number(yearText) : currentLocalDate.year;
	let requestedDate = createDateTime(year, month, Number(dayText), timezone);
	if (!requestedDate) return undefined;

	if (!yearText && requestedDate.startOf("day") < currentLocalDate.startOf("day")) {
		year += 1;
		requestedDate = createDateTime(year, month, Number(dayText), timezone);
	}

	return requestedDate?.toISODate() ?? undefined;
}

function extractRelativeDate(message: string, currentLocalDate: DateTime): string | undefined {
	const normalizedMessage = normalizeWords(message);
	const relativeDateMatch = normalizedMessage.match(
		/\b(day after tomorrow|today|tomorrow|tommorow|tomorow|tommorrow|tommrow|tmrw|tmr)\b/,
	);

	if (relativeDateMatch?.[1]) {
		const daysFromToday =
			relativeDateMatch[1] === "today"
				? 0
				: relativeDateMatch[1] === "day after tomorrow"
					? 2
					: 1;
		return currentLocalDate.plus({ days: daysFromToday }).toISODate() ?? undefined;
	}

	const weekdayMatch = normalizedMessage.match(
		/\b(next\s+)?(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
	);
	if (!weekdayMatch?.[2]) return undefined;

	const targetWeekday = WEEKDAY_NUMBERS[weekdayMatch[2]];
	if (targetWeekday === undefined) return undefined;

	const currentWeekday = currentLocalDate.weekday;
	let daysAhead = (targetWeekday - currentWeekday + 7) % 7;

	if (weekdayMatch[1] && daysAhead === 0) daysAhead = 7;

	return currentLocalDate.plus({ days: daysAhead }).toISODate() ?? undefined;
}

function createRequestedDate(
	year: number,
	month: number,
	day: number,
	timezone: string,
): string | undefined {
	return createDateTime(year, month, day, timezone)?.toISODate() ?? undefined;
}

function createDateTime(
	year: number,
	month: number,
	day: number,
	timezone: string,
): DateTime | undefined {
	const date = DateTime.fromObject({ year, month, day }, { zone: timezone });
	return date.isValid ? date : undefined;
}

function extractRequestedTime(message: string, allowBareHour: boolean): string | undefined {
	const twelveHourTime = message.match(/\b([0-9]{1,2})(?::([0-9]{2}))?\s*(am|pm)\b/i);
	if (twelveHourTime?.[1] && twelveHourTime[3]) {
		let hour = Number(twelveHourTime[1]);
		const minute = Number(twelveHourTime[2] ?? "0");
		if (hour < 1 || hour > 12 || minute > 59) return undefined;

		if (twelveHourTime[3].toLowerCase() === "pm" && hour !== 12) hour += 12;
		if (twelveHourTime[3].toLowerCase() === "am" && hour === 12) hour = 0;
		return formatTime(hour, minute);
	}

	const twentyFourHourTime = message.match(/\b([01]?[0-9]|2[0-3]):([0-5][0-9])\b/);
	if (twentyFourHourTime?.[1] && twentyFourHourTime[2]) {
		return formatTime(Number(twentyFourHourTime[1]), Number(twentyFourHourTime[2]));
	}

	if (allowBareHour) {
		const bareHour = message.trim().match(/^([0-9]{1,2})$/)?.[1];
		if (bareHour && Number(bareHour) <= 23) {
			return formatTime(Number(bareHour), 0);
		}
	}

	return undefined;
}

function formatTime(hour: number, minute: number): string {
	return `${String(hour).padStart(2, "0")}:${String(minute).padStart(2, "0")}`;
}

function extractConfirmation(message: string): boolean | undefined {
	const normalizedMessage = normalizeWords(message);

	if (
		["yes", "yes please", "correct", "confirmed", "confirm", "okay", "ok"].includes(
			normalizedMessage,
		)
	) {
		return true;
	}

	if (["no", "no thanks", "incorrect", "do not", "dont", "cancel"].includes(normalizedMessage)) {
		return false;
	}

	return undefined;
}

function isContinuationAcknowledgement(message: string): boolean {
	return /\b(yes|sure|okay|ok|do it|go ahead|continue|that works)\b/i.test(message);
}

function extractComplaintCategory(message: string): ComplaintCategory | undefined {
	const normalizedMessage = normalizeWords(message);

	if (normalizedMessage.includes("refund") || normalizedMessage.includes("charge")) {
		return "refund_or_charge";
	}

	if (normalizedMessage.includes("injury") || normalizedMessage.includes("injured")) {
		return "injury";
	}

	if (normalizedMessage.includes("safety")) return "safety";
	if (normalizedMessage.includes("quality")) return "grooming_quality";
	if (normalizedMessage.includes("service") || normalizedMessage.includes("wait")) {
		return "operational";
	}

	return undefined;
}

function normalizeWords(value: string): string {
	return value
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, " ")
		.trim();
}
