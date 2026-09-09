import { google } from "googleapis";

import { EXT, getGoogleServiceAccountCredentials } from "../config/constants.js";
import { Appointment, type AppointmentSlot } from "../models/appointment.js";
import type { BusinessConfig, ServiceId } from "../models/business.js";
import { localDateTimeToDate } from "./calendar-time.js";
import type {
	AppointmentRequest,
	AppointmentCalendar,
	CalendarAppointmentWriter,
	CalendarEvent,
	CalendarEventRequest,
	CalendarEventSource,
} from "./receptionist-dependencies.js";

export class GoogleCalendarClient
	implements CalendarEventSource, CalendarAppointmentWriter, AppointmentCalendar
{
	private readonly calendarApi: ReturnType<typeof google.calendar>;

	constructor(
		private readonly business: BusinessConfig,
		calendarApi: ReturnType<typeof google.calendar> = createGoogleCalendarApi(),
	) {
		this.calendarApi = calendarApi;
	}

	//get all the events scheduled between given start and end time
	async findEvents(request: CalendarEventRequest): Promise<readonly CalendarEvent[]> {
		this.ensureBusiness(request.businessId);

		const events: CalendarEvent[] = [];
		let pageToken: string | undefined;

		do {
			const response = await this.calendarApi.events.list({
				calendarId: this.business.calendar.calendarId,
				timeMin: request.timeMin,
				timeMax: request.timeMax,
				singleEvents: true,
				orderBy: "startTime",
				showDeleted: false,
				timeZone: this.business.timezone,
				...(pageToken ? { pageToken } : {}),
			});

			for (const event of response.data.items ?? []) {
				if (event.status === "cancelled") {
					continue;
				}

				const startAt = getEventTime(event.start, this.business.timezone);
				const endAt = getEventTime(event.end, this.business.timezone);

				if (!event.id || !startAt || !endAt) {
					throw new Error("Calendar event is missing an ID or time range");
				}

				events.push({ id: event.id, startAt, endAt });
			}

			pageToken = response.data.nextPageToken ?? undefined;
		} while (pageToken);

		return events;
	}

	async createAppointment(request: AppointmentRequest): Promise<Appointment> {
		this.ensureBusiness(request.businessId);

		const service = this.business.services.find(
			(configuredService) => configuredService.id === request.serviceId,
		);

		if (!service) {
			throw new Error("Appointment service is not configured for this business");
		}

		const response = await this.calendarApi.events.insert({
			calendarId: this.business.calendar.calendarId,
			requestBody: {
				summary: `${service.name} for ${request.petName}`,
				description: `Customer: ${request.customerName}\nContact: ${request.contactPhone}`,
				//these details are not shared with each copy of events.
				extendedProperties: {
					private: {
						businessId: this.business.id,
						contactPhone: request.contactPhone,
						customerName: request.customerName,
						petName: request.petName,
						serviceId: request.serviceId,
					},
				},
				start: {
					dateTime: request.startAt,
					timeZone: this.business.timezone,
				},
				end: {
					dateTime: request.endAt,
					timeZone: this.business.timezone,
				},
			},
		});

		const eventId = response.data.id;
		const startAt = response.data.start?.dateTime;
		const endAt = response.data.end?.dateTime;

		if (!eventId || !startAt || !endAt) {
			throw new Error("Created Calendar event is missing an ID or time range");
		}

		return new Appointment({
			id: eventId,
			businessId: this.business.id,
			contactPhone: request.contactPhone,
			petName: request.petName,
			serviceId: request.serviceId,
			startAt,
			endAt,
		});
	}

	async findAppointments(businessId: string, contactPhone: string): Promise<Appointment[]> {
		this.ensureBusiness(businessId);

		const appointments: Appointment[] = [];
		let pageToken: string | undefined;

		do {
			const response = await this.calendarApi.events.list({
				calendarId: this.business.calendar.calendarId,
				privateExtendedProperty: [
					`businessId=${this.business.id}`,
					`contactPhone=${contactPhone}`,
				],
				singleEvents: true, // merge recuring event into single event
				orderBy: "startTime",
				showDeleted: false,
				timeZone: this.business.timezone,
				...(pageToken ? { pageToken } : {}), // this keep sending all page event for this client
			});

			for (const event of response.data.items ?? []) {
				if (event.status === "cancelled") {
					continue;
				}

				appointments.push(toAppointment(event, this.business));
			}

			pageToken = response.data.nextPageToken ?? undefined;
		} while (pageToken);

		return appointments;
	}

	async rescheduleAppointment(
		appointmentId: string,
		slot: AppointmentSlot,
	): Promise<Appointment> {
		const response = await this.calendarApi.events.patch({
			calendarId: this.business.calendar.calendarId,
			eventId: appointmentId,
			requestBody: {
				start: {
					dateTime: slot.startAt,
					timeZone: this.business.timezone,
				},
				end: {
					dateTime: slot.endAt,
					timeZone: this.business.timezone,
				},
			},
		});

		return toAppointment(response.data, this.business);
	}

	async cancelAppointment(appointmentId: string): Promise<void> {
		await this.calendarApi.events.delete({
			calendarId: this.business.calendar.calendarId,
			eventId: appointmentId,
		});
	}

	private ensureBusiness(businessId: string): void {
		if (businessId !== this.business.id) {
			throw new Error("Business does not match the configured calendar");
		}
	}
}

function createGoogleCalendarApi(): ReturnType<typeof google.calendar> {
	const credentials = getGoogleServiceAccountCredentials();
	const auth = new google.auth.JWT({
		email: credentials.clientEmail,
		key: credentials.privateKey,
		scopes: [`${EXT.googleapis.baseUrl}${EXT.googleapis.paths.calendarScope}`],
	});

	return google.calendar({ version: "v3", auth });
}

function getEventTime(
	eventTime: { dateTime?: string | null; date?: string | null } | undefined,
	timeZone: string,
): string | undefined {
	if (eventTime?.dateTime) {
		return eventTime.dateTime;
	}

	if (eventTime?.date) {
		return localDateTimeToDate(eventTime.date, "00:00", timeZone).toISOString();
	}

	return undefined;
}

interface GoogleCalendarEvent {
	id?: string | null;
	start?: {
		dateTime?: string | null;
	} | null;
	end?: {
		dateTime?: string | null;
	} | null;
	extendedProperties?: {
		private?: Record<string, string> | null;
	} | null;
}

function toAppointment(event: GoogleCalendarEvent, business: BusinessConfig): Appointment {
	const properties = event.extendedProperties?.private;
	const serviceId = findServiceId(properties?.serviceId, business);

	if (
		!event.id ||
		!event.start?.dateTime ||
		!event.end?.dateTime ||
		properties?.businessId !== business.id ||
		!properties.contactPhone ||
		!properties.petName ||
		!serviceId
	) {
		throw new Error("Calendar appointment is missing booking details");
	}

	return new Appointment({
		id: event.id,
		businessId: business.id,
		contactPhone: properties.contactPhone,
		petName: properties.petName,
		serviceId,
		startAt: event.start.dateTime,
		endAt: event.end.dateTime,
	});
}

function findServiceId(value: string | undefined, business: BusinessConfig): ServiceId | undefined {
	if (!value) {
		return undefined;
	}

	for (const service of business.services) {
		if (service.id === value) {
			return service.id;
		}
	}

	return undefined;
}
