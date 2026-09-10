import type { BusinessConfig, GroomingService } from "../models/business.js";
import { createConversationOutcome, type ConversationOutcome } from "../models/receptionist.js";

const WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

export interface BreedOrSizeQuestion {
	serviceName?: string;
	breedOrMix?: string;
	weightLb?: number;
	safetyConcern?: string;
}

export class BusinessInformationService {
	constructor(private readonly business: BusinessConfig) {}

	answerServices(requestedServiceNames?: readonly string[]): ConversationOutcome {
		const requestedServices = requestedServiceNames?.filter(
			(serviceName) => serviceName.trim().length > 0,
		);

		if (!requestedServices || requestedServices.length === 0) {
			return createConversationOutcome(
				"answered",
				`We offer ${formatServiceNames(this.business.services)}.`,
			);
		}

		const availableServices: GroomingService[] = [];
		const unavailableServices: string[] = [];

		for (const requestedServiceName of requestedServices) {
			const service = this.findService(requestedServiceName);

			if (service) {
				if (!availableServices.includes(service)) {
					availableServices.push(service);
				}
			} else if (!unavailableServices.includes(requestedServiceName)) {
				unavailableServices.push(requestedServiceName);
			}
		}

		if (availableServices.length === 0) {
			return createConversationOutcome(
				"unavailable",
				`We do not offer ${formatTextList(unavailableServices)}.`,
			);
		}

		if (unavailableServices.length > 0) {
			return createConversationOutcome(
				"needs_information",
				`We offer ${formatServiceNames(availableServices)}, but not ${formatTextList(unavailableServices)}. Would you like to continue with an available service?`,
			);
		}

		const onlyAvailableService = availableServices[0];
		if (onlyAvailableService && availableServices.length === 1) {
			return createConversationOutcome(
				"answered",
				formatServiceDetails(onlyAvailableService),
			);
		}

		return createConversationOutcome(
			"answered",
			`We offer ${formatServiceNames(availableServices)}.`,
		);
	}

	answerPricing(serviceName: string | undefined, weightLb?: number): ConversationOutcome {
		if (!serviceName || serviceName.trim().length === 0) {
			return createConversationOutcome(
				"needs_information",
				"Which grooming service would you like pricing for?",
			);
		}

		const service = this.findService(serviceName);
		if (!service) {
			return createConversationOutcome(
				"unavailable",
				`We do not offer ${serviceName.trim()}.`,
			);
		}

		if (weightLb !== undefined && !isValidWeight(weightLb)) {
			return createConversationOutcome(
				"needs_information",
				"What is your dog's approximate weight so I can give the most useful estimate?",
			);
		}

		if (weightLb !== undefined && weightLb > this.business.humanReviewWeightLb) {
			return createConversationOutcome(
				"needs_human",
				"A groomer needs to review this dog's size before we provide a price estimate.",
			);
		}

		let summary = `${service.name} starts at $${service.startingPriceDollars}. The final price may vary based on your dog's size, coat condition, behavior, and time required.`;

		if (weightLb !== undefined && weightLb >= this.business.largeDogMinimumWeightLb) {
			summary += ` Dogs from ${this.business.largeDogMinimumWeightLb} to ${this.business.humanReviewWeightLb} lb require ${this.business.largeDogExtraMinutes} additional minutes.`;
		}

		return createConversationOutcome("answered", summary);
	}

	answerBusinessHours(dayName?: string): ConversationOutcome {
		if (dayName && dayName.trim().length > 0) {
			const day = findWeekday(dayName);

			if (!day) {
				return createConversationOutcome(
					"needs_information",
					"Which day would you like to know the business hours for?",
				);
			}

			if (this.isClosedDay(day)) {
				return createConversationOutcome(
					"answered",
					`${this.business.name} is closed on ${day}.`,
				);
			}

			return createConversationOutcome(
				"answered",
				`${this.business.name} is open on ${day} from ${formatTime(this.business.openingTime)} to ${formatTime(this.business.closingTime)}. The business timezone is ${this.business.timezone}.`,
			);
		}

		const openDays = WEEKDAYS.filter((day) => !this.isClosedDay(day));
		const closedDays = WEEKDAYS.filter((day) => this.isClosedDay(day));
		let summary = `${this.business.name} is open ${formatDayList(openDays)} from ${formatTime(this.business.openingTime)} to ${formatTime(this.business.closingTime)}. The business timezone is ${this.business.timezone}.`;

		if (closedDays.length > 0) {
			summary += ` It is closed on ${formatDayList(closedDays)}.`;
		}

		return createConversationOutcome("answered", summary);
	}

	answerBreedOrSize(question: BreedOrSizeQuestion): ConversationOutcome {
		if (question.safetyConcern && question.safetyConcern.trim().length > 0) {
			return createConversationOutcome(
				"needs_human",
				"A groomer needs to review the safety concern before we advise on suitability.",
			);
		}

		if (!question.serviceName || question.serviceName.trim().length === 0) {
			return createConversationOutcome(
				"needs_information",
				"Which grooming service are you asking about?",
			);
		}

		const service = this.findService(question.serviceName);
		if (!service) {
			return createConversationOutcome(
				"unavailable",
				`We do not offer ${question.serviceName.trim()}.`,
			);
		}

		if (question.weightLb === undefined || !isValidWeight(question.weightLb)) {
			return createConversationOutcome(
				"needs_information",
				"What is your dog's approximate weight so I can check the service suitability?",
			);
		}

		if (question.weightLb > this.business.humanReviewWeightLb) {
			return createConversationOutcome(
				"needs_human",
				"A groomer needs to review dogs over the configured size limit before we confirm service suitability.",
			);
		}

		let summary = `${service.name} can be considered for a dog weighing ${question.weightLb} lb. Breed alone does not determine eligibility.`;

		if (question.weightLb >= this.business.largeDogMinimumWeightLb) {
			summary += ` This size requires ${this.business.largeDogExtraMinutes} additional minutes.`;
		}

		return createConversationOutcome("answered", summary);
	}

	answerVaccination(): ConversationOutcome {
		const guidance = this.business.rabiesVaccinationGuidance.trim();

		if (guidance.length === 0) {
			return createConversationOutcome(
				"needs_human",
				"A team member needs to confirm the vaccination requirements.",
			);
		}

		if (!this.business.rabiesVaccinationRequired) {
			return createConversationOutcome(
				"answered",
				`${this.business.name} does not require current rabies vaccination proof. ${guidance}`,
			);
		}

		return createConversationOutcome("answered", guidance);
	}

	private findService(serviceName: string): GroomingService | undefined {
		const normalizedName = normalizeServiceName(serviceName);

		for (const service of this.business.services) {
			if (
				service.id === normalizedName ||
				normalizeServiceName(service.name) === normalizedName
			) {
				return service;
			}
		}

		return undefined;
	}

	private isClosedDay(day: string): boolean {
		return this.business.closedDays.some(
			(closedDay) => closedDay.toLowerCase() === day.toLowerCase(),
		);
	}
}

function isValidWeight(weightLb: number): boolean {
	return Number.isFinite(weightLb) && weightLb > 0;
}

function normalizeServiceName(serviceName: string): string {
	return serviceName.trim().toLowerCase().replace(/\s+/g, "-");
}

function findWeekday(dayName: string): string | undefined {
	for (const day of WEEKDAYS) {
		if (day.toLowerCase() === dayName.trim().toLowerCase()) {
			return day;
		}
	}

	return undefined;
}

function formatServiceNames(services: readonly GroomingService[]): string {
	return formatTextList(services.map((service) => service.name));
}

function formatServiceDetails(service: GroomingService): string {
	return `${service.name} includes ${formatTextList(service.includedItems)}. It starts at $${service.startingPriceDollars} and takes about ${formatDuration(service.durationMinutes)}.`;
}

function formatDuration(durationMinutes: number): string {
	if (durationMinutes % 60 === 0) {
		const hours = durationMinutes / 60;
		return hours === 1 ? "1 hour" : `${hours} hours`;
	}

	return `${durationMinutes} minutes`;
}

function formatTextList(values: readonly string[]): string {
	if (values.length === 1) {
		return values[0] ?? "";
	}

	const lastValue = values[values.length - 1] ?? "";
	return `${values.slice(0, -1).join(", ")}, and ${lastValue}`;
}

function formatDayList(days: readonly string[]): string {
	if (days.length === 0) {
		return "no days";
	}

	if (days.length === 1) {
		return days[0] ?? "";
	}

	if (days.length === 2) {
		return `${days[0]} and ${days[1]}`;
	}

	const firstDayIndex = WEEKDAYS.indexOf(days[0] ?? "");
	const daysAreConsecutive = days.every(
		(day, index) => WEEKDAYS.indexOf(day) === firstDayIndex + index,
	);

	if (daysAreConsecutive) {
		return `${days[0]} through ${days[days.length - 1]}`;
	}

	return formatTextList(days);
}

function formatTime(time: string): string {
	const [hourText, minuteText] = time.split(":");
	const hour = Number(hourText);
	const displayHour = hour % 12 || 12;
	const period = hour >= 12 ? "PM" : "AM";

	return `${displayHour}:${minuteText} ${period}`;
}
