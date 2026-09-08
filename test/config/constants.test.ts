import assert from "node:assert/strict";
import { test } from "node:test";

import { findBusinessConfig } from "../../src/config/constants.js";

test("loads the requested business configuration", () => {
	const businessConfig = findBusinessConfig("maple-street-dog-grooming");

	assert.ok(businessConfig);
	assert.equal(businessConfig.name, "Maple Street Dog Grooming");
});

test("returns undefined for an unknown business", () => {
	const businessConfig = findBusinessConfig("unknown-business");

	assert.equal(businessConfig, undefined);
});
