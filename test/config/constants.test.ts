import assert from "node:assert/strict";
import { test } from "node:test";

import { getBusinessConfig } from "../../src/config/constants.js";

test("loads the requested business configuration", () => {
	const businessConfig = getBusinessConfig("maple-street-dog-grooming");

	assert.equal(businessConfig.name, "Maple Street Dog Grooming");
});

test("rejects an unknown business", () => {
	assert.throws(
		() => getBusinessConfig("unknown-business"),
		new Error("Unknown business: unknown-business"),
	);
});
