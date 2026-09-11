import assert from "node:assert/strict";
import { test } from "node:test";

import { findBusinessConfig, getVapiConfig } from "../../src/config/constants.js";

test("loads the requested business configuration", () => {
	const businessConfig = findBusinessConfig("maple-street-dog-grooming");

	assert.ok(businessConfig);
	assert.equal(businessConfig.name, "Maple Street Dog Grooming");
});

test("returns undefined for an unknown business", () => {
	const businessConfig = findBusinessConfig("unknown-business");

	assert.equal(businessConfig, undefined);
});

test("leaves Vapi disabled when its environment variables are absent", () => {
	assert.equal(getVapiConfig({}), undefined);
});

test("loads Vapi authentication and trusted business phone mapping", () => {
	const config = getVapiConfig({
		VAPI_SERVER_TOKEN: "server-token",
		VAPI_PHONE_NUMBER: "+14155550100",
	});

	assert.deepEqual(config, {
		serverToken: "server-token",
		businessPhoneMappings: [
			{
				businessId: "maple-street-dog-grooming",
				phoneNumber: "+14155550100",
			},
		],
	});
});

test("rejects partial Vapi configuration", () => {
	assert.throws(
		() => getVapiConfig({ VAPI_SERVER_TOKEN: "server-token" }),
		/VAPI_SERVER_TOKEN and VAPI_PHONE_NUMBER must be configured together/,
	);
});

test("rejects an invalid Vapi phone number", () => {
	assert.throws(
		() =>
			getVapiConfig({
				VAPI_SERVER_TOKEN: "server-token",
				VAPI_PHONE_NUMBER: "415-555-0100",
			}),
		/VAPI_PHONE_NUMBER must use E.164 format/,
	);
});

test("rejects a Vapi mapping for an unknown business", () => {
	assert.throws(
		() =>
			getVapiConfig({
				VAPI_SERVER_TOKEN: "server-token",
				VAPI_PHONE_NUMBER: "+14155550100",
				VAPI_BUSINESS_ID: "unknown-business",
			}),
		/VAPI_BUSINESS_ID references an unknown business/,
	);
});
