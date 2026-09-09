import assert from "node:assert/strict";
import { test } from "node:test";

import {
	Customer,
	InvalidCustomerError,
	InvalidPetError,
	Pet,
	type PetDetails,
} from "../../src/models/customer.js";

test("creates valid customer and pet details", () => {
	const customer = new Customer("+14155550100", " Jamie ");
	const pet = new Pet({
		name: " Luna ",
		breedOrMix: " Labrador mix ",
		weightLb: 72,
		rabiesVaccinationStatus: "current",
		behaviorConcerns: " Nervous around dryers ",
	});

	assert.equal(customer.contactPhone, "+14155550100");
	assert.equal(customer.name, "Jamie");
	assert.equal(pet.name, "Luna");
	assert.equal(pet.breedOrMix, "Labrador mix");
	assert.equal(pet.behaviorConcerns, "Nervous around dryers");
});

test("rejects an invalid customer phone number", () => {
	assert.throws(() => new Customer("415-555-0100"), InvalidCustomerError);
});

test("rejects missing pet names and non-positive weights", () => {
	const validDetails: PetDetails = {
		name: "Luna",
		weightLb: 30,
		rabiesVaccinationStatus: "unknown",
	};

	assert.throws(() => new Pet({ ...validDetails, name: " " }), InvalidPetError);
	assert.throws(() => new Pet({ ...validDetails, weightLb: 0 }), InvalidPetError);
});
