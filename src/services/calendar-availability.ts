import { AppointmentSlot } from "../models/appointment.js";
import type { BusinessConfig } from "../models/business.js";
import type {
	AvailabilityRequest,
	AvailabilityResult,
	CalendarAvailability,
	CalendarEvent,
	CalendarEventSource,
} from "./receptionist-dependencies.js";
import { addLocalDays, getDayName, getLocalDate, localDateTimeToDate } from "./calendar-time.js";

interface BusyTimeRange {
	startAt: number;
	endAt: number;
}

export class InvalidAvailabilityRequestError extends Error {}

export class CalendarAvailabilityService implements CalendarAvailability {
	constructor(
		private readonly business: BusinessConfig,
		private readonly calendarEventSource: CalendarEventSource,
	) {}

	// find the available slots, if not present suggest the available slots.
	async findAvailableSlots(request: AvailabilityRequest): Promise<AvailabilityResult> {
		this.validateRequest(request);

		const service = this.business.services.find(
			(configuredService) => configuredService.id === request.serviceId,
		);

		if (!service) {
			return unavailable("The requested service is not configured for this business.");
		}

		const reviewReason = getHumanReviewReason(this.business, request);
		if (reviewReason) {
			return {
				status: "needs_human",
				slots: [],
				reason: reviewReason,
			};
		}

		const durationMinutes = getAppointmentDuration(
			this.business,
			service.durationMinutes,
			request.dogWeightLb,
		);
		const searchFrom = new Date(request.searchFrom);
		const searchWindow = getSearchWindow(this.business, searchFrom);

		let busyTimeRanges: BusyTimeRange[];

		try {
			const events = await this.calendarEventSource.findEvents({
				businessId: request.businessId,
				timeMin: searchWindow.timeMin.toISOString(),
				timeMax: searchWindow.timeMax.toISOString(),
			});
			busyTimeRanges = events.map(toBusyTimeRange);
		} catch (error) {
			return unavailable("Calendar availability could not be checked.", error);
		}

		const slots = buildSlots(
			this.business,
			searchFrom,
			searchWindow,
			durationMinutes,
			busyTimeRanges,
		);

		if (slots.length === 0) {
			return unavailable("No suitable appointment slots were found in the search window.");
		}

		return { status: "available", slots };
	}

	private validateRequest(request: AvailabilityRequest): void {
		if (request.businessId !== this.business.id) {
			throw new InvalidAvailabilityRequestError(
				"Business does not match the configured calendar",
			);
		}

		if (!Number.isFinite(request.dogWeightLb) || request.dogWeightLb <= 0) {
			throw new InvalidAvailabilityRequestError("Dog weight must be greater than zero");
		}

		if (
			!Number.isInteger(this.business.groomerCapacity) ||
			this.business.groomerCapacity <= 0
		) {
			throw new InvalidAvailabilityRequestError("Groomer capacity must be greater than zero");
		}

		if (
			!Number.isInteger(this.business.availabilitySearchDays) ||
			this.business.availabilitySearchDays <= 0
		) {
			throw new InvalidAvailabilityRequestError(
				"Availability search days must be greater than zero",
			);
		}

		if (
			!Number.isInteger(this.business.availabilitySlotIncrementMinutes) ||
			this.business.availabilitySlotIncrementMinutes <= 0
		) {
			throw new InvalidAvailabilityRequestError(
				"Availability slot increment must be greater than zero",
			);
		}

		if (!Number.isFinite(Date.parse(request.searchFrom))) {
			throw new InvalidAvailabilityRequestError("Search start must be a valid ISO date");
		}
	}
}

function getHumanReviewReason(
	business: BusinessConfig,
	request: AvailabilityRequest,
): string | undefined {
	if (request.dogWeightLb > business.humanReviewWeightLb) {
		return "Dogs over the configured weight limit require owner review before scheduling.";
	}

	if (request.safetyConcern?.trim()) {
		return "Safety-sensitive concerns require owner review before scheduling.";
	}

	return undefined;
}

// add the extra duration for large dogs
function getAppointmentDuration(
	business: BusinessConfig,
	serviceDurationMinutes: number,
	dogWeightLb: number,
): number {
	const needsExtraTime = dogWeightLb >= business.largeDogMinimumWeightLb;
	return needsExtraTime
		? serviceDurationMinutes + business.largeDogExtraMinutes
		: serviceDurationMinutes;
}

function getSearchWindow(
	business: BusinessConfig,
	searchFrom: Date,
): { firstLocalDate: string; lastLocalDate: string; timeMin: Date; timeMax: Date } {
	const firstLocalDate = getLocalDate(searchFrom, business.timezone);
	const lastLocalDate = addLocalDays(firstLocalDate, business.availabilitySearchDays - 1);

	return {
		firstLocalDate,
		lastLocalDate,
		timeMin: localDateTimeToDate(firstLocalDate, business.openingTime, business.timezone),
		timeMax: localDateTimeToDate(lastLocalDate, business.closingTime, business.timezone),
	};
}

function buildSlots(
	business: BusinessConfig,
	searchFrom: Date,
	searchWindow: { firstLocalDate: string; lastLocalDate: string },
	durationMinutes: number,
	busyTimeRanges: readonly BusyTimeRange[],
): AppointmentSlot[] {
	const slots: AppointmentSlot[] = [];
	let localDate = searchWindow.firstLocalDate;

	while (localDate <= searchWindow.lastLocalDate) {
		const dayDate = localDateTimeToDate(localDate, "12:00", business.timezone);

		if (!business.closedDays.includes(getDayName(dayDate, business.timezone))) {
			const openingTime = localDateTimeToDate(
				localDate,
				business.openingTime,
				business.timezone,
			);
			const closingTime = localDateTimeToDate(
				localDate,
				business.closingTime,
				business.timezone,
			);
			let candidateStart = getFirstCandidateStart(
				openingTime,
				searchFrom,
				business.availabilitySlotIncrementMinutes,
			);

			while (candidateStart.getTime() + durationMinutes * 60_000 <= closingTime.getTime()) {
				const candidateEnd = new Date(candidateStart.getTime() + durationMinutes * 60_000);

				if (
					!exceedsGroomerCapacity(
						candidateStart,
						candidateEnd,
						busyTimeRanges,
						business.groomerCapacity,
					)
				) {
					slots.push(
						new AppointmentSlot(
							candidateStart.toISOString(),
							candidateEnd.toISOString(),
						),
					);
				}

				candidateStart = new Date(
					candidateStart.getTime() + business.availabilitySlotIncrementMinutes * 60_000,
				);
			}
		}

		localDate = addLocalDays(localDate, 1);
	}

	return slots;
}

function getFirstCandidateStart(
	openingTime: Date,
	searchFrom: Date,
	slotIncrementMinutes: number,
): Date {
	if (searchFrom.getTime() <= openingTime.getTime()) {
		return openingTime;
	}

	const minutesAfterOpening = (searchFrom.getTime() - openingTime.getTime()) / 60_000;
	const roundedMinutes =
		Math.ceil(minutesAfterOpening / slotIncrementMinutes) * slotIncrementMinutes;

	return new Date(openingTime.getTime() + roundedMinutes * 60_000);
}

// start and endTime must be not inside the busy schedule
function exceedsGroomerCapacity(
	startAt: Date,
	endAt: Date,
	busyTimeRanges: readonly BusyTimeRange[],
	groomerCapacity: number,
): boolean {
	const overlappingAppointments = busyTimeRanges.filter(
		(busyTime) => busyTime.startAt < endAt.getTime() && busyTime.endAt > startAt.getTime(),
	);

	return overlappingAppointments.length >= groomerCapacity;
}

function toBusyTimeRange(event: CalendarEvent): BusyTimeRange {
	const startAt = Date.parse(event.startAt);
	const endAt = Date.parse(event.endAt);

	if (!Number.isFinite(startAt) || !Number.isFinite(endAt) || endAt <= startAt) {
		throw new Error(`Calendar event ${event.id} has invalid times`);
	}

	return { startAt, endAt };
}

function unavailable(reason: string, cause?: unknown): AvailabilityResult {
	const result: AvailabilityResult = {
		status: "unavailable",
		slots: [],
		reason,
	};

	if (cause) {
		result.reason = `${reason} Please try again or ask the owner to follow up.`;
	}

	return result;
}
