import assert from "node:assert/strict";
import { test } from "node:test";

import { findBusinessConfig } from "../../src/config/constants.js";
import { Pet, Customer } from "../../src/models/customer.js";
import { createConversationOutcome } from "../../src/models/receptionist.js";
import {
	GoogleSheetsCallLog,
	GoogleSheetsContacts,
	SheetsPersistenceError,
	type SpreadsheetClient,
	type SpreadsheetRow,
} from "../../src/services/google-sheets-persistence.js";
import type { CallLogEntry, ContactRecord } from "../../src/services/receptionist-dependencies.js";

const business = findBusinessConfig("maple-street-dog-grooming");

if (!business) {
	throw new Error("Expected Maple Street business configuration in test setup");
}

class FakeSpreadsheetClient implements SpreadsheetClient {
	private readonly tabs = new Map<string, SpreadsheetRow[]>();
	readonly readRequests: { spreadsheetId: string; tabName: string }[] = [];
	readonly appendRequests: {
		spreadsheetId: string;
		tabName: string;
		values: readonly string[];
	}[] = [];
	readonly updateRequests: {
		spreadsheetId: string;
		tabName: string;
		rowNumber: number;
		values: readonly string[];
	}[] = [];
	readFailure: Error | undefined;
	writeFailure: Error | undefined;

	async readRows(spreadsheetId: string, tabName: string): Promise<readonly SpreadsheetRow[]> {
		this.readRequests.push({ spreadsheetId, tabName });

		if (this.readFailure) {
			throw this.readFailure;
		}

		return this.getRows(spreadsheetId, tabName);
	}

	async appendRow(
		spreadsheetId: string,
		tabName: string,
		values: readonly string[],
	): Promise<void> {
		this.appendRequests.push({ spreadsheetId, tabName, values });

		if (this.writeFailure) {
			throw this.writeFailure;
		}

		const rows = this.getRows(spreadsheetId, tabName);
		rows.push({ rowNumber: rows.length + 1, values: [...values] });
	}

	async updateRow(
		spreadsheetId: string,
		tabName: string,
		rowNumber: number,
		values: readonly string[],
	): Promise<void> {
		this.updateRequests.push({ spreadsheetId, tabName, rowNumber, values });

		if (this.writeFailure) {
			throw this.writeFailure;
		}

		const rows = this.getRows(spreadsheetId, tabName);
		const row = rows.find((candidate) => candidate.rowNumber === rowNumber);

		if (!row) {
			throw new Error(`Row ${rowNumber} does not exist`);
		}

		row.values = [...values];
	}

	setRows(spreadsheetId: string, tabName: string, rows: SpreadsheetRow[]): void {
		this.tabs.set(this.getKey(spreadsheetId, tabName), rows);
	}

	getRows(spreadsheetId: string, tabName: string): SpreadsheetRow[] {
		const key = this.getKey(spreadsheetId, tabName);
		const rows = this.tabs.get(key);

		if (rows) {
			return rows;
		}

		const newRows: SpreadsheetRow[] = [];
		this.tabs.set(key, newRows);
		return newRows;
	}

	private getKey(spreadsheetId: string, tabName: string): string {
		return `${spreadsheetId}:${tabName}`;
	}
}

function createContact(name: string, lastContactAt: string): ContactRecord {
	if (!business) {
		throw new Error("Expected Maple Street business configuration in test setup");
	}

	return {
		businessId: business.id,
		customer: new Customer("+14155550100", name),
		pets: [
			new Pet({
				name: "Milo",
				breedOrMix: "Poodle mix",
				weightLb: 25,
				rabiesVaccinationStatus: "current",
			}),
		],
		notes: "Prefers a quiet appointment",
		lastContactAt,
	};
}

test("stores and reads one contact row using the configured spreadsheet and tab", async () => {
	const client = new FakeSpreadsheetClient();
	const contacts = new GoogleSheetsContacts(business, client);
	const contact = createContact("Alex Morgan", "2026-09-09T10:00:00.000Z");

	await contacts.save(contact);
	const savedContact = await contacts.findByContactPhone(business.id, "+14155550100");

	assert.ok(savedContact);
	assert.equal(savedContact.customer.name, "Alex Morgan");
	assert.equal(savedContact.pets[0]?.name, "Milo");
	assert.equal(savedContact.notes, "Prefers a quiet appointment");
	assert.equal(savedContact.lastContactAt, "2026-09-09T10:00:00.000Z");
	assert.deepEqual(client.appendRequests[0], {
		spreadsheetId: business.sheets.spreadsheetId,
		tabName: business.sheets.contactsTabName,
		values: ["contactPhone", "customerName", "pets", "notes", "lastContactAt"],
	});
});

test("updates the existing contact row instead of creating a duplicate", async () => {
	const client = new FakeSpreadsheetClient();
	const contacts = new GoogleSheetsContacts(business, client);

	await contacts.save(createContact("Alex Morgan", "2026-09-09T10:00:00.000Z"));
	client.appendRequests.length = 0;
	client.updateRequests.length = 0;

	await contacts.save(createContact("Alex M.", "2026-09-09T11:00:00.000Z"));

	assert.equal(client.appendRequests.length, 0);
	assert.equal(client.updateRequests.length, 1);
	assert.equal(client.updateRequests[0]?.rowNumber, 2);
	assert.equal(
		client.getRows(business.sheets.spreadsheetId, business.sheets.contactsTabName).length,
		2,
	);
});

test("rejects a sheet that already contains duplicate contact rows", async () => {
	const client = new FakeSpreadsheetClient();
	client.setRows(business.sheets.spreadsheetId, business.sheets.contactsTabName, [
		{
			rowNumber: 1,
			values: ["contactPhone", "customerName", "pets", "notes", "lastContactAt"],
		},
		{ rowNumber: 2, values: ["+14155550100", "Alex", "[]", "", "2026-09-09T10:00:00.000Z"] },
		{ rowNumber: 3, values: ["+14155550100", "Alex", "[]", "", "2026-09-09T10:00:00.000Z"] },
	]);

	const contacts = new GoogleSheetsContacts(business, client);

	await assert.rejects(
		contacts.findByContactPhone(business.id, "+14155550100"),
		(error: unknown) =>
			error instanceof SheetsPersistenceError &&
			error.message.includes("Multiple contact rows"),
	);
});

test("records completed or handed-off conversations in the Call Log tab", async () => {
	const client = new FakeSpreadsheetClient();
	const callLog = new GoogleSheetsCallLog(business, client);
	const entry: CallLogEntry = {
		businessId: business.id,
		conversationId: "conversation-123",
		intents: ["pricing", "book_appointment", "complaint"],
		callerPhone: "+14155550100",
		contactPhone: "+14155550100",
		outcome: createConversationOutcome(
			"needs_human",
			"Owner callback requested for a complaint.",
		),
		endedAt: "2026-09-09T12:00:00.000Z",
	};

	await callLog.append(entry);

	const rows = client.getRows(business.sheets.spreadsheetId, business.sheets.callLogTabName);
	assert.deepEqual(rows[0]?.values, [
		"businessId",
		"conversationId",
		"endedAt",
		"callerPhone",
		"contactPhone",
		"intents",
		"outcomeStatus",
		"outcomeSummary",
		"callbackRequested",
		"appointmentId",
	]);
	assert.deepEqual(rows[1]?.values, [
		business.id,
		"conversation-123",
		"2026-09-09T12:00:00.000Z",
		"+14155550100",
		"+14155550100",
		"pricing, book_appointment, complaint",
		"needs_human",
		"Owner callback requested for a complaint.",
		"true",
		"",
	]);
});

test("converts spreadsheet failures into controlled persistence errors", async () => {
	const client = new FakeSpreadsheetClient();
	client.readFailure = new Error("Google is unavailable");
	const contacts = new GoogleSheetsContacts(business, client);

	await assert.rejects(
		contacts.findByContactPhone(business.id, "+14155550100"),
		(error: unknown) =>
			error instanceof SheetsPersistenceError &&
			error.message === "Unable to read the Contacts sheet",
	);
});
