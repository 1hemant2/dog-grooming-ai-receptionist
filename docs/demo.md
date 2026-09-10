# Phase 1 Demo Guide

This walkthrough exercises the browser UI, Gemini interpretation, deterministic business rules,
Google Calendar, Google Sheets, and Telegram owner notifications.

## Prepare Google and Telegram

1. Create or select a Google Cloud project and enable the Google Sheets API and Google Calendar API.
2. Create a service account and download its credentials.
3. Create a dedicated demo spreadsheet and share it with the service-account email as an editor.
4. Create a dedicated demo Calendar and share it with the service account with permission to change events.
5. Create a Telegram bot, start a chat with it, and obtain the target chat ID.
6. Copy `.env.example` to `.env` and provide the credentials and resource IDs.

Keep `.env` local. Never commit or paste its values into screenshots, logs, or review notes.

## Prepare demo records manually

Create the `Contacts` tab in the configured Google Sheet and add one or two future Calendar events.
The records should include:

- Alex Morgan at `+14155550100`, with Milo as a 65 lb Golden Retriever with current rabies proof.
- One future 60-minute Bath appointment for Milo.
- One 60-minute blocked Calendar slot on the next open day.

Keep the Calendar date and time values nearby for the walkthrough. Use a dedicated demo Calendar and
Sheet so the records visible during the video are easy to understand. Manually reset the appointment
between rescheduling, cancellation, and late-arrival scenarios when needed.

## Google Sheet columns

The `Contacts` tab uses these columns:

| Column          | Meaning                                            |
| --------------- | -------------------------------------------------- |
| `contactPhone`  | Confirmed customer contact in E.164 format         |
| `customerName`  | Customer name used for appointment identity checks |
| `pets`          | JSON array of validated pet records                |
| `notes`         | Operational notes for later conversations          |
| `lastContactAt` | Last successful contact update in ISO format       |

The `Call Log` tab uses these columns:

| Column              | Meaning                                                             |
| ------------------- | ------------------------------------------------------------------- |
| `businessId`        | Business that handled the conversation                              |
| `conversationId`    | Request and follow-up correlation ID                                |
| `endedAt`           | Outcome timestamp in ISO format                                     |
| `callerPhone`       | Optional channel-provided caller number                             |
| `contactPhone`      | Customer-confirmed contact number                                   |
| `intent`            | Interpreted customer request                                        |
| `outcomeStatus`     | Answered, completed, unavailable, needs-information, or needs-human |
| `outcomeSummary`    | Context needed to understand or continue the request                |
| `callbackRequested` | Whether owner follow-up is required                                 |
| `appointmentId`     | Related Calendar event ID when available                            |

## Run the browser demo

Start the application and open `http://localhost:3000`:

```bash
npm run dev
```

The UI keeps the server-issued conversation ID in browser session storage. The optional caller
phone is locked after it is first provided. Use **Start new conversation** between unrelated
scenarios so one customer's state does not affect another.

## Scenario checklist

Natural-language extraction can vary slightly, so answer follow-up questions using the same facts
shown below. The deterministic services make the final business decision.

### Information enquiries

Start a new conversation for each prompt:

- Services: `What grooming services do you offer?`
- Pricing: `What is the starting price for a full groom for a 65 lb dog?`
- Hours: `Are you open on Sunday?`
- Breed and size: `Can you groom a 65 lb Golden Retriever with no health or behavior concerns?`
- Vaccination: `Does Milo need current rabies vaccination proof?`

Verify that answers use Maple Street configuration, Sunday is closed, pricing is presented as a
starting estimate, and breed alone does not cause rejection.

### Book an appointment

Use a new conversation and an open date from the Calendar. Send:

`My name is Jordan Lee. I confirm +14155550102 as my contact number. My dog Daisy is 30 lb, has current rabies vaccination, and needs a Bath at [OPEN DATE AND TIME]. I confirm the booking details.`

Verify that the browser displays `completed` and an appointment ID, Calendar contains one new
event, `Contacts` contains Jordan and Daisy, and `Call Log` records the completed booking. Sending
the same confirmed message again must not create another event.

### Reschedule an appointment

Use the seeded Alex and Milo record:

1. Send `I am Alex Morgan. I confirm +14155550100 as my contact number. I need to reschedule Milo's appointment.`
2. Request the occupied Calendar time and verify that no Calendar change occurs.
3. Request an open Calendar time and explicitly confirm the move.

Verify that Calendar moves the appointment once, `Call Log` records the result, and Telegram
receives the owner notification.

### Cancel an appointment

Reset the demo appointment in Calendar, start a new conversation, and send:

`I am Alex Morgan. I confirm +14155550100 as my contact number. Please cancel Milo's appointment. I confirm the cancellation.`

Verify that Calendar cancels the event, `Call Log` records the cancellation, and Telegram receives
the owner notification.

### Running late

Reset the demo appointment in Calendar before this scenario.

- Send a 10-minute delay for Alex and Milo and verify that it is recorded and sent to Telegram.
- In a new conversation, send a 15-minute delay and verify a `needs_human` response without an
  automatic schedule decision.

Example: `I am Alex Morgan and confirm +14155550100 as my contact number. Milo and I will be 10 minutes late for his appointment.`

### Complaints and handoff

Use a new conversation for each case:

- Refund decision: `I am Alex Morgan and confirm +14155550100 as my contact number. Milo's appointment has a disputed $95 charge and I want a refund.`
- Safety concern: `I am Alex Morgan and confirm +14155550100 as my contact number. I need to report an injury concern after Milo's grooming.`
- Other unresolved complaint: `I am Alex Morgan and confirm +14155550100 as my contact number. I want the owner to call me about an unresolved grooming complaint.`
- Resolved operational concern: `I am Alex Morgan and confirm +14155550100 as my contact number. I had trouble finding the entrance, but the posted sign resolved it. Please record this feedback.`

Verify that refund, safety, and unresolved cases request human follow-up without promising fault,
refunds, or compensation. The resolved operational concern may be recorded as completed when the
interpreter extracts the stated resolution.

## Final verification

Before presenting the project, run:

```bash
npm install
npm run check
npm run build
```

Confirm that `.env`, `dist/`, and any screenshots containing credentials remain untracked.
