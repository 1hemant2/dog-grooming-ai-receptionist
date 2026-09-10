import assert from "node:assert/strict";
import { test } from "node:test";

import { google } from "googleapis";

import { GoogleSheetsClient } from "../../src/services/google-sheets-client.js";

test("writes appended rows from column A", async () => {
	const updateRequests: { request: Record<string, unknown> }[] = [];
	const sheetsApi = {
		spreadsheets: {
			values: {
				get: async () => ({ data: { values: [["existing", "row"]] } }),
				update: async (request: Record<string, unknown>) => {
					updateRequests.push({ request });
				},
			},
		},
	} as unknown as ReturnType<typeof google.sheets>;
	const client = new GoogleSheetsClient(sheetsApi);

	await client.appendRow("spreadsheet-id", "Call Log", ["businessId", "conversationId"]);

	assert.deepEqual(updateRequests[0]?.request, {
		spreadsheetId: "spreadsheet-id",
		range: "'Call Log'!A2:B2",
		valueInputOption: "RAW",
		requestBody: { values: [["businessId", "conversationId"]] },
	});
});
