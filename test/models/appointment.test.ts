import assert from "node:assert/strict";
import { test } from "node:test";

import {
	Appointment,
	AppointmentStateError,
	InvalidAppointmentError,
	type AppointmentDetails,
} from "../../src/models/appointment.js";

const appointmentDetails: AppointmentDetails = {
	id: "appointment-1",
	businessId: "maple-street-dog-grooming",
	contactPhone: "+14155550100",
	petName: "Luna",
	serviceId: "bath",
	startAt: "2026-09-10T09:00:00-07:00",
	endAt: "2026-09-10T10:00:00-07:00",
};

test("reschedules a scheduled appointment", () => {
	const appointment = new Appointment(appointmentDetails);

	appointment.reschedule("2026-09-11T11:00:00-07:00", "2026-09-11T12:00:00-07:00");

	assert.equal(appointment.startAt, "2026-09-11T11:00:00-07:00");
	assert.equal(appointment.endAt, "2026-09-11T12:00:00-07:00");
});

test("rejects invalid appointment time ranges", () => {
	assert.throws(
		() =>
			new Appointment({
				...appointmentDetails,
				endAt: appointmentDetails.startAt,
			}),
		InvalidAppointmentError,
	);
});

test("does not change a cancelled appointment", () => {
	const appointment = new Appointment(appointmentDetails);
	appointment.cancel();

	assert.equal(appointment.status, "cancelled");
	assert.throws(
		() => appointment.reschedule("2026-09-11T11:00:00-07:00", "2026-09-11T12:00:00-07:00"),
		AppointmentStateError,
	);
});
