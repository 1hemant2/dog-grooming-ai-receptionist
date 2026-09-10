import assert from "node:assert/strict";
import { test } from "node:test";

import { findBusinessConfig } from "../../src/config/constants.js";
import type { BusinessConfig } from "../../src/models/business.js";
import { BusinessInformationService } from "../../src/services/business-information.js";

const business = findBusinessConfig("maple-street-dog-grooming");

if (!business) {
	throw new Error("Expected Maple Street business configuration in test setup");
}

test("answers service availability from business configuration", () => {
	const service = new BusinessInformationService(business);

	const allServices = service.answerServices();
	const unsupportedService = service.answerServices(["nail trimming"]);
	const mixedServices = service.answerServices(["bath", "nail trimming"]);

	assert.equal(allServices.status, "answered");
	assert.match(allServices.summary, /Bath/);
	assert.equal(unsupportedService.status, "unavailable");
	assert.match(unsupportedService.summary, /nail trimming/);
	assert.equal(mixedServices.status, "needs_information");
	assert.match(mixedServices.summary, /Bath/);
});

test("answers what a configured service includes", () => {
	const service = new BusinessInformationService(business);

	const fullGroom = service.answerServices(["full groom"]);

	assert.equal(fullGroom.status, "answered");
	assert.match(fullGroom.summary, /shampoo and conditioner/);
	assert.match(fullGroom.summary, /nail trim/);
	assert.match(fullGroom.summary, /complete haircut and style/);
	assert.match(fullGroom.summary, /starts at \$95/);
	assert.match(fullGroom.summary, /takes about 2 hours/);
});

test("answers configured starting prices with a disclaimer", () => {
	const service = new BusinessInformationService(business);

	const price = service.answerPricing("bath", 50);
	const maximumSupportedWeight = service.answerPricing("bath", 100);
	const missingService = service.answerPricing(undefined);
	const oversizedDog = service.answerPricing("bath", 101);

	assert.equal(price.status, "answered");
	assert.match(price.summary, /starts at \$45/);
	assert.match(price.summary, /final price may vary/);
	assert.equal(maximumSupportedWeight.status, "answered");
	assert.match(maximumSupportedWeight.summary, /additional minutes/);
	assert.equal(missingService.status, "needs_information");
	assert.equal(oversizedDog.status, "needs_human");
});

test("answers configured business hours and closures", () => {
	const service = new BusinessInformationService(business);

	const weeklyHours = service.answerBusinessHours();
	const sundayHours = service.answerBusinessHours("sunday");
	const unknownDay = service.answerBusinessHours("holiday");

	assert.match(weeklyHours.summary, /Monday through Saturday/);
	assert.match(weeklyHours.summary, /9:00 AM to 5:00 PM/);
	assert.match(sundayHours.summary, /closed on Sunday/);
	assert.equal(unknownDay.status, "needs_information");
});

test("checks suitability by size without rejecting by breed", () => {
	const service = new BusinessInformationService(business);

	const suitableDog = service.answerBreedOrSize({
		serviceName: "Bath",
		breedOrMix: "Rottweiler mix",
		weightLb: 60,
	});
	const largeDog = service.answerBreedOrSize({ serviceName: "Bath", weightLb: 75 });
	const oversizedDog = service.answerBreedOrSize({ serviceName: "Bath", weightLb: 101 });
	const safetyConcern = service.answerBreedOrSize({
		serviceName: "Bath",
		weightLb: 50,
		safetyConcern: "active illness",
	});

	assert.equal(suitableDog.status, "answered");
	assert.match(suitableDog.summary, /Breed alone does not determine eligibility/);
	assert.match(largeDog.summary, /additional minutes/);
	assert.equal(oversizedDog.status, "needs_human");
	assert.equal(safetyConcern.status, "needs_human");
});

test("answers vaccination guidance from the selected business", () => {
	const customBusiness: BusinessConfig = {
		...business,
		rabiesVaccinationGuidance: "Please bring the current rabies certificate.",
	};
	const vaccinationNotRequiredBusiness: BusinessConfig = {
		...business,
		rabiesVaccinationRequired: false,
		rabiesVaccinationGuidance: "The shop does not require vaccination proof.",
	};
	const service = new BusinessInformationService(customBusiness);
	const serviceWithoutRequirement = new BusinessInformationService(
		vaccinationNotRequiredBusiness,
	);

	const vaccination = service.answerVaccination();
	const vaccinationNotRequired = serviceWithoutRequirement.answerVaccination();

	assert.equal(vaccination.status, "answered");
	assert.equal(vaccination.summary, "Please bring the current rabies certificate.");
	assert.match(
		vaccinationNotRequired.summary,
		/does not require current rabies vaccination proof/,
	);
});
