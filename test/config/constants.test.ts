import assert from "node:assert/strict";
import { test } from "node:test";

import { findBusinessConfig, getLiveKitConfig, getVapiConfig } from "../../src/config/constants.js";

test("loads the requested business configuration", () => {
	const businessConfig = findBusinessConfig("maple-street-dog-grooming");

	assert.ok(businessConfig);
	assert.equal(businessConfig.name, "Maple Street Dog Grooming");
	assert.equal(businessConfig.timezone, "Asia/Calcutta");
	assert.equal(businessConfig.phone.countryCallingCode, "91");
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

test("leaves LiveKit disabled when its environment variables are absent", () => {
	assert.equal(getLiveKitConfig({}), undefined);
});

test("normalizes LiveKit URLs without requiring a worker backend token", () => {
	const config = getLiveKitConfig({
		LIVEKIT_URL: "https://demo.livekit.cloud/",
		LIVEKIT_API_KEY: "api-key",
		LIVEKIT_API_SECRET: "api-secret",
		LIVEKIT_AGENT_NAME: "demo-agent",
	});

	assert.deepEqual(config, {
		websocketUrl: "wss://demo.livekit.cloud",
		host: "https://demo.livekit.cloud",
		apiKey: "api-key",
		apiSecret: "api-secret",
		agentName: "demo-agent",
	});
});

test("rejects partial LiveKit configuration", () => {
	assert.throws(
		() => getLiveKitConfig({ LIVEKIT_URL: "wss://demo.livekit.cloud" }),
		/LIVEKIT_URL, LIVEKIT_API_KEY, and LIVEKIT_API_SECRET must be configured together/,
	);
});
