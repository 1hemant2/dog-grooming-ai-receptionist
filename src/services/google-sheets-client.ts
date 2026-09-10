import { google } from "googleapis";

import {
	APPLICATION_CONFIG,
	EXT,
	getGoogleServiceAccountCredentials,
} from "../config/constants.js";
import type { SpreadsheetClient, SpreadsheetRow } from "./google-sheets-persistence.js";

const SHEET_COLUMN_RANGE = "A:ZZ";

// read, append and update the rows
export class GoogleSheetsClient implements SpreadsheetClient {
	private readonly sheetsApi: ReturnType<typeof google.sheets>;

	constructor(sheetsApi: ReturnType<typeof google.sheets> = createGoogleSheetsApi()) {
		this.sheetsApi = sheetsApi;
	}

	async readRows(spreadsheetId: string, tabName: string): Promise<readonly SpreadsheetRow[]> {
		const response = await this.sheetsApi.spreadsheets.values.get(
			{
				spreadsheetId,
				range: `${quoteTabName(tabName)}!${SHEET_COLUMN_RANGE}`,
			},
			{ timeout: APPLICATION_CONFIG.externalRequestTimeoutMs },
		);
		const values = response.data.values ?? [];

		return values.map((row, index) => ({
			rowNumber: index + 1,
			values: row.map((value) => String(value ?? "")),
		}));
	}

	async appendRow(
		spreadsheetId: string,
		tabName: string,
		values: readonly string[],
	): Promise<void> {
		const rows = await this.readRows(spreadsheetId, tabName);
		const nextRowNumber = rows.length + 1;

		await this.updateRow(spreadsheetId, tabName, nextRowNumber, values);
	}

	async updateRow(
		spreadsheetId: string,
		tabName: string,
		rowNumber: number,
		values: readonly string[],
	): Promise<void> {
		if (values.length === 0) {
			throw new Error("Cannot update a spreadsheet row without values");
		}

		await this.sheetsApi.spreadsheets.values.update(
			{
				spreadsheetId,
				range: `${quoteTabName(tabName)}!A${rowNumber}:${getColumnName(values.length)}${rowNumber}`,
				valueInputOption: "USER_ENTERED",
				requestBody: { values: [Array.from(values)] },
			},
			{ timeout: APPLICATION_CONFIG.externalRequestTimeoutMs },
		);
	}
}

function createGoogleSheetsApi(): ReturnType<typeof google.sheets> {
	const credentials = getGoogleServiceAccountCredentials();
	const auth = new google.auth.JWT({
		email: credentials.clientEmail,
		key: credentials.privateKey,
		scopes: [`${EXT.googleapis.baseUrl}${EXT.googleapis.paths.sheetsScope}`],
	});

	return google.sheets({ version: "v4", auth });
}

function quoteTabName(tabName: string): string {
	return `'${tabName.replaceAll("'", "''")}'`;
}

function getColumnName(columnNumber: number): string {
	let currentNumber = columnNumber;
	let columnName = "";

	while (currentNumber > 0) {
		const remainder = (currentNumber - 1) % 26;
		columnName = String.fromCharCode(65 + remainder) + columnName;
		currentNumber = Math.floor((currentNumber - 1) / 26);
	}

	return columnName;
}
