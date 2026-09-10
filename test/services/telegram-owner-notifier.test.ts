import assert from "node:assert/strict";
import { test } from "node:test";

import {
	TelegramNotificationError,
	TelegramOwnerNotifier,
} from "../../src/services/telegram-owner-notifier.js";

const config = {
	botToken: "telegram-test-token",
	chatId: "telegram-test-chat",
};

test("sends an owner notification through Telegram", async () => {
	let requestUrl = "";
	let requestBody = "";

	const fetcher: typeof fetch = async (input, init) => {
		requestUrl = String(input);
		requestBody = String(init?.body);
		return new Response(JSON.stringify({ ok: true }), { status: 200 });
	};

	const notifier = new TelegramOwnerNotifier(config, fetcher);
	await notifier.notify("Owner review required for appointment-1");

	assert.equal(requestUrl, "https://api.telegram.org/bottelegram-test-token/sendMessage");
	assert.deepEqual(JSON.parse(requestBody), {
		chat_id: "telegram-test-chat",
		text: "Owner review required for appointment-1",
	});
});

test("returns a controlled error when Telegram rejects the request", async () => {
	const fetcher: typeof fetch = async () =>
		new Response(JSON.stringify({ ok: false, description: "Chat not found" }), {
			status: 400,
		});
	const notifier = new TelegramOwnerNotifier(config, fetcher);

	await assert.rejects(notifier.notify("Test message"), TelegramNotificationError);
});

test("returns a controlled error when Telegram returns an invalid response", async () => {
	const fetcher: typeof fetch = async () =>
		new Response("not-json", {
			status: 200,
		});
	const notifier = new TelegramOwnerNotifier(config, fetcher);

	await assert.rejects(notifier.notify("Test message"), TelegramNotificationError);
});

test("rejects an empty owner notification", async () => {
	const fetcher: typeof fetch = async () =>
		new Response(JSON.stringify({ ok: true }), { status: 200 });
	const notifier = new TelegramOwnerNotifier(config, fetcher);

	await assert.rejects(notifier.notify("  "), TelegramNotificationError);
});
