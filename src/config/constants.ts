import type { BusinessConfig } from "./business.js";

const DEFAULT_PORT = 3000;
const DEFAULT_BUSINESS_ID = "maple-street-dog-grooming";

export const APPLICATION_CONFIG = {
	port: getPort(),
};

export const BUSINESS_CONFIGS: BusinessConfig[] = [
	{
		id: DEFAULT_BUSINESS_ID,
		name: "Maple Street Dog Grooming",
		timezone: "America/Los_Angeles",
		openingTime: "09:00",
		closingTime: "17:00",
		closedDays: ["Sunday"],
		groomerCapacity: 1,
		rescheduleNoticeHours: 24,
		lateHandoffMinutes: 15,
		largeDogMinimumWeightLb: 71,
		humanReviewWeightLb: 100,
		largeDogExtraMinutes: 30,
		availabilitySearchDays: 7,
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

export function getBusinessConfig(businessId: string): BusinessConfig {
	for (const businessConfig of BUSINESS_CONFIGS) {
		if (businessConfig.id === businessId) {
			return businessConfig;
		}
	}

	throw new Error(`Unknown business: ${businessId}`);
}

function getPort(): number {
	const port = Number(process.env.PORT ?? DEFAULT_PORT);

	if (!Number.isInteger(port) || port < 1 || port > 65_535) {
		throw new Error("PORT must be an integer between 1 and 65535");
	}

	return port;
}
