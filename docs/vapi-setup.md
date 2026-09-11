# Vapi voice setup

This setup connects a Vapi phone assistant to the existing receptionist backend. Vapi handles speech; the application remains responsible for conversation state, business rules, Calendar, Sheets, Telegram, and final Call Log persistence.

## Start the local application

Provide these environment variables through the local environment or the launch mechanism used by the developer:

```text
VAPI_SERVER_TOKEN=<the same bearer token configured in Vapi>
VAPI_PHONE_NUMBER=<the Vapi phone number in E.164 format>
VAPI_BUSINESS_ID=maple-street-dog-grooming
```

Start the application with `npm run dev` and confirm that `GET /health` returns a healthy response.

## Start the HTTPS tunnel

The Vapi dashboard requires an HTTPS endpoint. For local development, forward the application port to a claimed ngrok dev domain:

```bash
ngrok http 3000 --url https://<your-ngrok-domain> --log=stdout
```

Keep the application and tunnel running during the call. The durable hostname is reusable, but the local process still has to be online.

## Configure the Vapi API Request Tool

Create or update an API Request Tool with these values:

- Name: `mapleStreetReceptionistMessage`
- Method: `POST`
- URL: `https://<your-ngrok-domain>/vapi/conversations/messages`
- Authentication: a reusable Bearer credential containing the same value as `VAPI_SERVER_TOKEN`

Define `message` as the required string in the request body. It represents only the caller's latest final utterance.

Add these static body fields so the model cannot invent trusted identity values:

| Field               | Value                                            |
| ------------------- | ------------------------------------------------ |
| `callId`            | `{{call.id}}`                                    |
| `calledPhoneNumber` | The configured Vapi phone number in E.164 format |
| `callerPhone`       | `{{customer.number}}`                            |

Extract the response field `reply` as a required string. The assistant should speak that value exactly once.

Configure delayed response messages:

- At approximately 1.2 seconds: “I’m checking that for you. One moment, please.”
- At approximately 7 seconds: “Thanks for your patience. I’m still working on that.”

Publish the tool after changing it.

## Configure the assistant and phone number

Create an assistant named `Maple Street Receptionist`, attach the published tool, and use a prompt that requires every caller turn to go through the tool. The assistant should speak the returned `reply` exactly once and avoid answering business questions from its own model knowledge.

Assign the assistant to the Vapi phone number. Set the phone number's server URL to:

```text
https://<your-ngrok-domain>/vapi/events
```

Use the same Bearer credential for this webhook and set a timeout long enough for the backend's controlled provider timeout. Save the phone number configuration.

## Verify the integration

1. Open the Vapi phone assistant or call the configured number.
2. Ask a fast question, such as the business hours; no delayed message should be needed.
3. Continue with a multi-turn flow, such as pricing followed by booking.
4. Verify Calendar and Sheets after a booking, reschedule, cancellation, or handoff.
5. End the call and verify one Call Log row with the final intents and outcome.
6. Check the application logs for duration and outcome metadata. Logs must not contain credentials, transcripts, or complete provider payloads.

The tunnel, Vapi credentials, phone number, and local environment values are deployment configuration. They must not be committed to the repository.
