import assert from "node:assert/strict";
import { test } from "node:test";

import { findBusinessConfig } from "../../src/config/constants.js";
import type {
	AvailabilityRequest,
	CalendarEvent,
	CalendarEventRequest,
	CalendarEventSource,
} from "../../src/services/receptionist-dependencies.js";
import { CalendarAvailabilityService } from "../../src/services/calendar-availability.js";

const business = findBusinessConfig("maple-street-dog-grooming");

if (!business) {
	throw new Error("Expected Maple Street business configuration in test setup");
}

class FakeCalendarEventSource implements CalendarEventSource {
	events: CalendarEvent[] = [];
	requests: CalendarEventRequest[] = [];
	failure: Error | undefined;

	async findEvents(request: CalendarEventRequest): Promise<readonly CalendarEvent[]> {
		this.requests.push(request);

		if (this.failure) {
			throw this.failure;
		}

		return this.events;
	}
}

function createRequest(
	dogWeightLb = 50,
	searchFrom = "2026-09-07T15:00:00.000Z",
): AvailabilityRequest {
	if (!business) {
		throw new Error("Expected Maple Street business configuration in test setup");
	}

	return {
		businessId: business.id,
		serviceId: "bath",
		dogWeightLb,
		searchFrom,
	};
}

test("includes large-dog extra time when calculating available slots", async () => {
	const eventSource = new FakeCalendarEventSource();
	const availability = new CalendarAvailabilityService(business, eventSource);

	const result = await availability.findAvailableSlots(createRequest(75));

	assert.equal(result.status, "available");
	assert.equal(result.slots.length, 84);
	assert.equal(result.slots[0]?.startAt, "2026-09-07T16:00:00.000Z");
	assert.equal(result.slots[0]?.endAt, "2026-09-07T17:30:00.000Z");
});

test("uses the business timezone, excludes closed days, and searches seven days", async () => {
	const eventSource = new FakeCalendarEventSource();
	const availability = new CalendarAvailabilityService(business, eventSource);

	const result = await availability.findAvailableSlots(
		createRequest(50, "2026-09-06T15:00:00.000Z"),
	);

	assert.equal(result.status, "available");
	assert.equal(result.slots[0]?.startAt, "2026-09-07T16:00:00.000Z");
	assert.equal(eventSource.requests[0]?.timeMin, "2026-09-06T16:00:00.000Z");
	assert.equal(eventSource.requests[0]?.timeMax, "2026-09-13T00:00:00.000Z");
	assert.ok(result.slots.every((slot) => new Date(slot.startAt).getUTCDay() !== 0));
});

test("blocks slots that overlap an existing appointment", async () => {
	const eventSource = new FakeCalendarEventSource();
	eventSource.events = [
		{
			id: "existing-appointment",
			startAt: "2026-09-07T17:00:00.000Z",
			endAt: "2026-09-07T18:00:00.000Z",
		},
	];
	const oneDayBusiness = { ...business, availabilitySearchDays: 1 };
	const availability = new CalendarAvailabilityService(oneDayBusiness, eventSource);

	const result = await availability.findAvailableSlots(createRequest());

	assert.equal(result.status, "available");
	assert.ok(result.slots.every((slot) => slot.startAt !== "2026-09-07T17:00:00.000Z"));
	assert.ok(result.slots.some((slot) => slot.startAt === "2026-09-07T18:00:00.000Z"));
});

test("requires human review for oversized dogs and safety concerns", async () => {
	const eventSource = new FakeCalendarEventSource();
	const availability = new CalendarAvailabilityService(business, eventSource);

	const oversizedDog = await availability.findAvailableSlots(createRequest(101));
	const safetyConcern = await availability.findAvailableSlots({
		...createRequest(),
		safetyConcern: "active illness",
	});

	assert.equal(oversizedDog.status, "needs_human");
	assert.equal(oversizedDog.slots.length, 0);
	assert.equal(safetyConcern.status, "needs_human");
	assert.equal(eventSource.requests.length, 0);
});

test("does not guess availability when Calendar reads fail", async () => {
	const eventSource = new FakeCalendarEventSource();
	eventSource.failure = new Error("Calendar is unavailable");
	const availability = new CalendarAvailabilityService(business, eventSource);

	const result = await availability.findAvailableSlots(createRequest());

	assert.equal(result.status, "unavailable");
	assert.equal(result.slots.length, 0);
	assert.match(result.reason ?? "", /could not be checked/);
});

test("returns unavailable when no suitable slot exists", async () => {
	const eventSource = new FakeCalendarEventSource();
	eventSource.events = [
		{
			id: "all-day-block",
			startAt: "2026-09-07T16:00:00.000Z",
			endAt: "2026-09-08T00:00:00.000Z",
		},
	];
	const oneDayBusiness = { ...business, availabilitySearchDays: 1 };
	const availability = new CalendarAvailabilityService(oneDayBusiness, eventSource);

	const result = await availability.findAvailableSlots(createRequest());

	assert.equal(result.status, "unavailable");
	assert.equal(result.slots.length, 0);
});
