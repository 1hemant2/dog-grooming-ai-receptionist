export type ServiceId = "bath" | "bath-and-trim" | "full-groom";

export interface GroomingService {
	id: ServiceId;
	name: string;
	durationMinutes: number;
	startingPriceDollars: number;
}

export interface BusinessConfig {
	id: string;
	name: string;
	timezone: string;
	openingTime: string;
	closingTime: string;
	closedDays: string[];
	rabiesVaccinationRequired: boolean;
	rabiesVaccinationGuidance: string;
	groomerCapacity: number;
	rescheduleNoticeHours: number;
	lateHandoffMinutes: number;
	largeDogMinimumWeightLb: number;
	humanReviewWeightLb: number;
	largeDogExtraMinutes: number;
	availabilitySearchDays: number;
	services: GroomingService[];
}
