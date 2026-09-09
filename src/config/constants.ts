import type { BusinessConfig } from "../models/business.js";

const DEFAULT_PORT = 3000;
const DEFAULT_BUSINESS_ID = "maple-street-dog-grooming";

export const APPLICATION_CONFIG = {
	port: getPort(),
	maxRequestBytes: 16_384,
	maxMessageCharacters: 4_000,
	maxConversationIdCharacters: 128,
};

// Store business configurations in an array so new vendors can be added without changing request handling.
export const BUSINESS_CONFIGS: BusinessConfig[] = [
	{
		id: DEFAULT_BUSINESS_ID,
		name: "Maple Street Dog Grooming",
		timezone: "America/Los_Angeles",
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
		services: [
			{ id: "bath", name: "Bath", durationMinutes: 60, startingPriceDollars: 45 },
			{
				id: "bath-and-trim",
				name: "Bath and Trim",
				durationMinutes: 90,
				startingPriceDollars: 70,
			},
			{
				id: "full-groom",
				name: "Full Groom",
				durationMinutes: 120,
				startingPriceDollars: 95,
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

function getPort(): number {
	const port = Number(process.env.PORT ?? DEFAULT_PORT);

	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("PORT must be an integer between 1 and 65535");
	}

	return port;
}
