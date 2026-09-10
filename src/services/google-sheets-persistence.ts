import { EXT } from "../config/constants.js";
import type { BusinessConfig } from "../models/business.js";
import {
	Customer,
	Pet,
	type PetDetails,
	type RabiesVaccinationStatus,
} from "../models/customer.js";
import type {
	CallLog,
	CallLogEntry,
	ContactRecord,
	Contacts,
} from "./receptionist-dependencies.js";

export interface SpreadsheetRow {
	rowNumber: number;
	values: readonly string[];
}

export interface SpreadsheetClient {
	readRows(spreadsheetId: string, tabName: string): Promise<readonly SpreadsheetRow[]>;
	appendRow(spreadsheetId: string, tabName: string, values: readonly string[]): Promise<void>;
	updateRow(
		spreadsheetId: string,
		tabName: string,
		rowNumber: number,
		values: readonly string[],
	): Promise<void>;
}

export class SheetsPersistenceError extends Error {}

export class GoogleSheetsContacts implements Contacts {
	constructor(
		private readonly business: BusinessConfig,
		private readonly spreadsheetClient: SpreadsheetClient,
	) {}

	// find the client by phone, and update the details instead of dubblicating it.
	async findByContactPhone(
		businessId: string,
		contactPhone: string,
	): Promise<ContactRecord | undefined> {
		this.ensureBusiness(businessId);
		const rows = await this.readRows();
		const normalizedContactPhone = normalizeStoredContactPhone(contactPhone, this.business);
		const matchingRows = getDataRows(rows, EXT.googleSheets.contacts.headers).filter(
			(row) =>
				normalizeStoredContactPhone(
					getCell(row, EXT.googleSheets.contacts.columns.contactPhone),
					this.business,
				) === normalizedContactPhone,
		);

		if (matchingRows.length === 0) {
			return undefined;
		}

		if (matchingRows.length > 1) {
			throw new SheetsPersistenceError(
				`Multiple contact rows found for ${contactPhone} in the Contacts sheet`,
			);
		}

		const row = matchingRows[0];
		if (!row) {
			return undefined;
		}

		return this.toContactRecord(businessId, row);
	}

	// If saving for first time, insert the header first then the value.
	async save(contact: ContactRecord): Promise<void> {
		this.ensureBusiness(contact.businessId);
		const rows = await this.readRows();
		const dataRows = getDataRows(rows, EXT.googleSheets.contacts.headers);
		const normalizedContactPhone = normalizeStoredContactPhone(
			contact.customer.contactPhone,
			this.business,
		);
		const matchingRows = dataRows.filter(
			(row) =>
				normalizeStoredContactPhone(
					getCell(row, EXT.googleSheets.contacts.columns.contactPhone),
					this.business,
				) === normalizedContactPhone,
		);

		if (matchingRows.length > 1) {
			throw new SheetsPersistenceError(
				`Multiple contact rows found for ${contact.customer.contactPhone} in the Contacts sheet`,
			);
		}

		const contactRow = this.toContactRow(contact);
		const matchingRow = matchingRows[0];

		if (matchingRow) {
			await this.updateRow(matchingRow.rowNumber, contactRow);
			return;
		}

		if (rows.length === 0) {
			await this.appendRow(EXT.googleSheets.contacts.headers);
		}

		await this.appendRow(contactRow);
	}

	private ensureBusiness(businessId: string): void {
		if (businessId !== this.business.id) {
			throw new SheetsPersistenceError("Business does not match the configured spreadsheet");
		}
	}

	private async readRows(): Promise<readonly SpreadsheetRow[]> {
		try {
			return await this.spreadsheetClient.readRows(
				this.business.sheets.spreadsheetId,
				this.business.sheets.contactsTabName,
			);
		} catch (error) {
			throw new SheetsPersistenceError("Unable to read the Contacts sheet", { cause: error });
		}
	}

	private async appendRow(values: readonly string[]): Promise<void> {
		try {
			await this.spreadsheetClient.appendRow(
				this.business.sheets.spreadsheetId,
				this.business.sheets.contactsTabName,
				values,
			);
		} catch (error) {
			throw new SheetsPersistenceError("Unable to write to the Contacts sheet", {
				cause: error,
			});
		}
	}

	private async updateRow(rowNumber: number, values: readonly string[]): Promise<void> {
		try {
			await this.spreadsheetClient.updateRow(
				this.business.sheets.spreadsheetId,
				this.business.sheets.contactsTabName,
				rowNumber,
				values,
			);
		} catch (error) {
			throw new SheetsPersistenceError("Unable to update the Contacts sheet", {
				cause: error,
			});
		}
	}

	private toContactRow(contact: ContactRecord): string[] {
		return [
			contact.customer.contactPhone,
			contact.customer.name ?? "",
			JSON.stringify(contact.pets),
			contact.notes ?? "",
			contact.lastContactAt,
		];
	}

	// convert the spread sheet details to js object.
	private toContactRecord(businessId: string, row: SpreadsheetRow): ContactRecord {
		const rawContactPhone = getRequiredCell(
			row,
			EXT.googleSheets.contacts.columns.contactPhone,
			"contact phone",
		);
		const contactPhone = normalizeStoredContactPhone(rawContactPhone, this.business);
		const customerName = getOptionalCell(row, EXT.googleSheets.contacts.columns.customerName);
		const pets = parsePets(getCell(row, EXT.googleSheets.contacts.columns.pets));
		const notes = getOptionalCell(row, EXT.googleSheets.contacts.columns.notes);
		const lastContactAt = getRequiredCell(
			row,
			EXT.googleSheets.contacts.columns.lastContactAt,
			"last contact timestamp",
		);

		try {
			const contact: ContactRecord = {
				businessId,
				customer: new Customer(contactPhone, customerName),
				pets,
				lastContactAt,
			};

			if (notes !== undefined) {
				contact.notes = notes;
			}

			return contact;
		} catch (error) {
			throw new SheetsPersistenceError(`Contacts sheet row ${row.rowNumber} is invalid`, {
				cause: error,
			});
		}
	}
}

function normalizeStoredContactPhone(value: string, business: BusinessConfig): string {
	const compactPhone = value.trim().replace(/[\s().-]/g, "");
	const countryCode = business.phone.countryCallingCode;
	const nationalNumberDigits = business.phone.nationalNumberDigits;

	if (compactPhone.startsWith("+")) return compactPhone;

	if (
		compactPhone.length === nationalNumberDigits ||
		(compactPhone.startsWith(countryCode) &&
			compactPhone.length === countryCode.length + nationalNumberDigits)
	) {
		return `+${compactPhone.length === nationalNumberDigits ? countryCode : ""}${compactPhone}`;
	}

	return compactPhone;
}

// append the conversation logs in call log sheet
export class GoogleSheetsCallLog implements CallLog {
	constructor(
		private readonly business: BusinessConfig,
		private readonly spreadsheetClient: SpreadsheetClient,
	) {}

	async append(entry: CallLogEntry): Promise<void> {
		if (entry.businessId !== this.business.id) {
			throw new SheetsPersistenceError("Business does not match the configured spreadsheet");
		}

		try {
			const rows = await this.spreadsheetClient.readRows(
				this.business.sheets.spreadsheetId,
				this.business.sheets.callLogTabName,
			);
			const dataRows = getDataRows(rows, EXT.googleSheets.callLog.headers);
			const alreadyLogged = dataRows.some(
				(row) =>
					getCell(row, EXT.googleSheets.callLog.columns.conversationId) ===
					entry.conversationId,
			);

			if (alreadyLogged) return;

			if (rows.length === 0) {
				await this.spreadsheetClient.appendRow(
					this.business.sheets.spreadsheetId,
					this.business.sheets.callLogTabName,
					EXT.googleSheets.callLog.headers,
				);
			}

			await this.spreadsheetClient.appendRow(
				this.business.sheets.spreadsheetId,
				this.business.sheets.callLogTabName,
				this.toCallLogRow(entry),
			);
		} catch (error) {
			throw new SheetsPersistenceError("Unable to write to the Call Log sheet", {
				cause: error,
			});
		}
	}

	private toCallLogRow(entry: CallLogEntry): string[] {
		return [
			entry.businessId,
			entry.conversationId,
			entry.endedAt,
			entry.callerPhone ?? "",
			entry.contactPhone ?? "",
			entry.intents.join(", "),
			entry.outcome.status,
			entry.outcome.summary,
			String(entry.outcome.callbackRequested),
			entry.outcome.appointmentId ?? "",
		];
	}
}

// get all the rows except the header.
function getDataRows(
	rows: readonly SpreadsheetRow[],
	headers: readonly string[],
): readonly SpreadsheetRow[] {
	const firstRow = rows[0];

	if (firstRow && hasHeaders(firstRow, headers)) {
		return rows.slice(1);
	}

	return rows;
}

// check if sheet have correct header or not.
function hasHeaders(row: SpreadsheetRow, headers: readonly string[]): boolean {
	return headers.every((header, index) => getCell(row, index) === header);
}

function getRequiredCell(row: SpreadsheetRow, column: number, fieldName: string): string {
	const value = getCell(row, column);

	if (value.length === 0) {
		throw new SheetsPersistenceError(
			`Contacts sheet row ${row.rowNumber} is missing ${fieldName}`,
		);
	}

	return value;
}

function getOptionalCell(row: SpreadsheetRow, column: number): string | undefined {
	const value = getCell(row, column);
	return value.length > 0 ? value : undefined;
}

// This function return the trim cell value.
function getCell(row: SpreadsheetRow, column: number): string {
	return row.values[column]?.trim() ?? "";
}

// validate the logged pet details in sheet
function parsePets(value: string): Pet[] {
	if (value.length === 0) {
		return [];
	}

	let parsedPets: unknown;

	try {
		parsedPets = JSON.parse(value);
	} catch (error) {
		throw new SheetsPersistenceError("Contacts sheet contains invalid pet data", {
			cause: error,
		});
	}

	if (!Array.isArray(parsedPets)) {
		throw new SheetsPersistenceError("Contacts sheet pet data must be an array");
	}

	return parsedPets.map((pet, index) => parsePet(pet, index));
}

function parsePet(value: unknown, index: number): Pet {
	if (!isRecord(value)) {
		throw new SheetsPersistenceError(`Contacts sheet pet ${index + 1} is invalid`);
	}

	if (
		typeof value.name !== "string" ||
		typeof value.weightLb !== "number" ||
		!isRabiesVaccinationStatus(value.rabiesVaccinationStatus)
	) {
		throw new SheetsPersistenceError(
			`Contacts sheet pet ${index + 1} is missing required fields`,
		);
	}

	const petDetails: PetDetails = {
		name: value.name,
		weightLb: value.weightLb,
		rabiesVaccinationStatus: value.rabiesVaccinationStatus,
	};

	if (typeof value.breedOrMix === "string") {
		petDetails.breedOrMix = value.breedOrMix;
	}

	if (typeof value.healthConcerns === "string") {
		petDetails.healthConcerns = value.healthConcerns;
	}

	if (typeof value.behaviorConcerns === "string") {
		petDetails.behaviorConcerns = value.behaviorConcerns;
	}

	try {
		return new Pet(petDetails);
	} catch (error) {
		throw new SheetsPersistenceError(`Contacts sheet pet ${index + 1} is invalid`, {
			cause: error,
		});
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRabiesVaccinationStatus(value: unknown): value is RabiesVaccinationStatus {
	return value === "current" || value === "expired" || value === "unknown";
}
