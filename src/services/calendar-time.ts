import { DateTime } from "luxon";

export function getLocalDate(date: Date, timeZone: string): string {
	return getISODate(getZonedDateTime(date, timeZone));
}

export function getDayName(date: Date, timeZone: string): string {
	return getZonedDateTime(date, timeZone).toFormat("cccc");
}

export function addLocalDays(localDate: string, days: number): string {
	const date = DateTime.fromISO(localDate, { zone: "UTC" });

	if (!date.isValid) {
		throw new Error(`Invalid local date: ${localDate}`);
	}

	return getISODate(date.plus({ days }));
}

export function localDateTimeToDate(localDate: string, localTime: string, timeZone: string): Date {
	const dateTime = DateTime.fromISO(`${localDate}T${localTime}`, {
		zone: timeZone,
	});

	if (!dateTime.isValid) {
		throw new Error(`Invalid local date/time: ${localDate} ${localTime}`);
	}

	return dateTime.toJSDate();
}

function getZonedDateTime(date: Date, timeZone: string): DateTime {
	const dateTime = DateTime.fromJSDate(date, { zone: timeZone });

	if (!dateTime.isValid) {
		throw new Error(`Invalid date or time zone: ${timeZone}`);
	}

	return dateTime;
}

function getISODate(dateTime: DateTime): string {
	const value = dateTime.toISODate();

	if (!value) {
		throw new Error("Unable to format date");
	}

	return value;
}
