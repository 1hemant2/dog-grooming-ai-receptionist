import type { ServiceId } from "./business.js";
import { isValidPhoneNumber } from "./customer.js";

const ISO_DATE_TIME_PATTERN =
	/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

export type AppointmentStatus = "scheduled" | "cancelled" | "completed";

export interface AppointmentDetails {
	id: string;
	businessId: string;
	contactPhone: string;
	petName: string;
	serviceId: ServiceId;
	startAt: string;
	endAt: string;
}

export class AppointmentSlot {
	readonly startAt: string;
	readonly endAt: string;

	constructor(startAt: string, endAt: string) {
		validateTimeRange(startAt, endAt);
		this.startAt = startAt;
		this.endAt = endAt;
	}
}

export class Appointment {
	readonly id: string;
	readonly businessId: string;
	readonly contactPhone: string;
	readonly petName: string;
	readonly serviceId: ServiceId;
	private scheduledStartAt: string;
	private scheduledEndAt: string;
	private currentStatus: AppointmentStatus = "scheduled";

	constructor(details: AppointmentDetails) {
		validateRequiredText(details.id, "Appointment ID");
		validateRequiredText(details.businessId, "Business ID");
		validateRequiredText(details.petName, "Pet name");
		validateTimeRange(details.startAt, details.endAt);

		if (!isValidPhoneNumber(details.contactPhone)) {
			throw new InvalidAppointmentError("Contact phone must use E.164 format");
		}

		this.id = details.id;
		this.businessId = details.businessId;
		this.contactPhone = details.contactPhone;
		this.petName = details.petName;
		this.serviceId = details.serviceId;
		this.scheduledStartAt = details.startAt;
		this.scheduledEndAt = details.endAt;
	}

	get startAt(): string {
		return this.scheduledStartAt;
	}

	get endAt(): string {
		return this.scheduledEndAt;
	}

	get status(): AppointmentStatus {
		return this.currentStatus;
	}

	reschedule(startAt: string, endAt: string): void {
		this.requireScheduled("reschedule");
		validateTimeRange(startAt, endAt);
		this.scheduledStartAt = startAt;
		this.scheduledEndAt = endAt;
	}

	cancel(): void {
		this.requireScheduled("cancel");
		this.currentStatus = "cancelled";
	}

	complete(): void {
		this.requireScheduled("complete");
		this.currentStatus = "completed";
	}

	private requireScheduled(action: string): void {
		if (this.currentStatus !== "scheduled") {
			throw new AppointmentStateError(`Cannot ${action} a ${this.currentStatus} appointment`);
		}
	}
}

export class InvalidAppointmentError extends Error {}

export class AppointmentStateError extends Error {}

export function validateTimeRange(startAt: string, endAt: string): void {
	const startTime = Date.parse(startAt);
	const endTime = Date.parse(endAt);

	if (
		!ISO_DATE_TIME_PATTERN.test(startAt) ||
		!ISO_DATE_TIME_PATTERN.test(endAt) ||
		!Number.isFinite(startTime) ||
		!Number.isFinite(endTime)
	) {
		throw new InvalidAppointmentError("Appointment times must be valid ISO dates");
	}

	if (endTime <= startTime) {
		throw new InvalidAppointmentError("Appointment end time must be after its start time");
	}
}

function validateRequiredText(value: string, fieldName: string): void {
	if (value.trim().length === 0) {
		throw new InvalidAppointmentError(`${fieldName} is required`);
	}
}
