const E164_PHONE_PATTERN = /^\+[1-9]\d{7,14}$/; // The first digit must be between 1 and 9; subsequent digits can be 0 through 9 which denote by d. The number must contain 8 to 15 digits after the plus sign.

export type RabiesVaccinationStatus = "current" | "expired" | "unknown";

export interface PetDetails {
	name: string;
	breedOrMix?: string;
	weightLb: number;
	rabiesVaccinationStatus: RabiesVaccinationStatus;
	healthConcerns?: string;
	behaviorConcerns?: string;
}

export class Customer {
	readonly contactPhone: string;
	readonly name: string | undefined;

	constructor(contactPhone: string, name?: string) {
		if (!isValidPhoneNumber(contactPhone)) {
			throw new InvalidCustomerError("Contact phone must use E.164 format");
		}

		this.contactPhone = contactPhone;
		this.name = normalizeOptionalText(name);
	}
}

export class Pet {
	readonly name: string;
	readonly breedOrMix: string | undefined;
	readonly weightLb: number;
	readonly rabiesVaccinationStatus: RabiesVaccinationStatus;
	readonly healthConcerns: string | undefined;
	readonly behaviorConcerns: string | undefined;

	constructor(details: PetDetails) {
		const name = details.name.trim();

		if (name.length === 0) {
			throw new InvalidPetError("Pet name is required");
		}

		if (!Number.isFinite(details.weightLb) || details.weightLb <= 0) {
			throw new InvalidPetError("Pet weight must be greater than zero");
		}

		this.name = name;
		this.breedOrMix = normalizeOptionalText(details.breedOrMix);
		this.weightLb = details.weightLb;
		this.rabiesVaccinationStatus = details.rabiesVaccinationStatus;
		this.healthConcerns = normalizeOptionalText(details.healthConcerns);
		this.behaviorConcerns = normalizeOptionalText(details.behaviorConcerns);
	}
}

export class InvalidCustomerError extends Error {}

export class InvalidPetError extends Error {}

export function isValidPhoneNumber(phoneNumber: string): boolean {
	return E164_PHONE_PATTERN.test(phoneNumber);
}

function normalizeOptionalText(value: string | undefined): string | undefined {
	const normalizedValue = value?.trim();
	return normalizedValue && normalizedValue.length > 0 ? normalizedValue : undefined;
}
