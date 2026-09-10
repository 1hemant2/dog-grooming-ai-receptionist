import assert from "node:assert/strict";
import { test } from "node:test";

import {
	addLocalDays,
	formatLocalDateTime,
	getDayName,
	getLocalDate,
	localDateTimeToDate,
} from "../../src/services/calendar-time.js";

test("converts a business local time to UTC across daylight-saving time", () => {
	const beforeDaylightSaving = localDateTimeToDate("2026-03-07", "09:00", "America/Los_Angeles");
	const afterDaylightSaving = localDateTimeToDate("2026-03-08", "09:00", "America/Los_Angeles");

	assert.equal(beforeDaylightSaving.toISOString(), "2026-03-07T17:00:00.000Z");
	assert.equal(afterDaylightSaving.toISOString(), "2026-03-08T16:00:00.000Z");
});

test("reads and advances dates in the business timezone", () => {
	const date = new Date("2026-09-07T00:00:00.000Z");

	assert.equal(getLocalDate(date, "America/Los_Angeles"), "2026-09-06");
	assert.equal(getDayName(date, "America/Los_Angeles"), "Sunday");
	assert.equal(addLocalDays("2026-09-06", 1), "2026-09-07");
});

test("formats a stored UTC appointment in the business timezone", () => {
	assert.equal(
		formatLocalDateTime("2026-09-11T18:00:00.000Z", "America/Los_Angeles"),
		"Friday, September 11 at 11:00 AM PDT",
	);
});
