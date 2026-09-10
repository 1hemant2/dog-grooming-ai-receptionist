import {
	APPLICATION_CONFIG,
	EXT,
	getTelegramOwnerNotificationConfig,
} from "../config/constants.js";
import type { OwnerNotifier } from "./receptionist-dependencies.js";

export interface TelegramOwnerNotificationConfig {
	botToken: string;
	chatId: string;
}

interface TelegramApiResponse {
	ok?: boolean;
	description?: string;
}

export class TelegramNotificationError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
	}
}

export class TelegramOwnerNotifier implements OwnerNotifier {
	constructor(
		private readonly config: TelegramOwnerNotificationConfig = getTelegramOwnerNotificationConfig(),
		private readonly fetcher: typeof fetch = fetch,
	) {}

	async notify(message: string): Promise<void> {
		if (message.trim().length === 0) {
			throw new TelegramNotificationError("Telegram notification message is required");
		}

		const url = `${EXT.telegram.baseUrl}/bot${this.config.botToken}${EXT.telegram.paths.sendMessage}`;
		let response: Response;

		try {
			response = await this.fetcher(url, {
				method: "POST",
				signal: AbortSignal.timeout(APPLICATION_CONFIG.externalRequestTimeoutMs),
				headers: {
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					chat_id: this.config.chatId,
					text: message,
				}),
			});
		} catch (error) {
			throw new TelegramNotificationError("Telegram notification request failed", {
				cause: error,
			});
		}

		let result: TelegramApiResponse;

		try {
			result = (await response.json()) as TelegramApiResponse;
		} catch (error) {
			throw new TelegramNotificationError("Telegram returned an invalid response", {
				cause: error,
			});
		}

		if (!response.ok || result.ok !== true) {
			throw new TelegramNotificationError(
				result.description ?? "Telegram did not accept the notification",
			);
		}
	}
}
