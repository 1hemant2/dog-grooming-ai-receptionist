import { google } from "googleapis";

import { EXT, getGoogleServiceAccountCredentials } from "../config/constants.js";
import type { BusinessConfig } from "../models/business.js";
import { localDateTimeToDate } from "./calendar-time.js";
import type {
	CalendarEvent,
	CalendarEventRequest,
	CalendarEventSource,
} from "./receptionist-dependencies.js";

export class GoogleCalendarClient implements CalendarEventSource {
	private readonly calendarApi: ReturnType<typeof google.calendar>;

	constructor(
		private readonly business: BusinessConfig,
		calendarApi: ReturnType<typeof google.calendar> = createGoogleCalendarApi(),
	) {
		this.calendarApi = calendarApi;
	}

	//get all the events scheduled between given start and end time
	async findEvents(request: CalendarEventRequest): Promise<readonly CalendarEvent[]> {
		if (request.businessId !== this.business.id) {
			throw new Error("Business does not match the configured calendar");
		}

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
