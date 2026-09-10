# Maple Street Receptionist

Phase 1 of the ProcIndex take-home: a text-based AI receptionist for a dog-grooming shop.

## Requirements

- Node.js 22 or newer
- npm 10 or newer
- Gemini API access
- A Google service account with access to the demo Calendar and Sheet
- A Telegram bot and chat for owner notifications

## Setup

```bash
npm install
cp .env.example .env
```

Configure `.env`, then create a `Contacts` tab in the Google Sheet and add a few future Calendar
events that demonstrate an occupied slot and a rescheduling option. The exact columns are described
in [docs/demo.md](docs/demo.md).

Start the application:

```bash
npm run dev
```

Open `http://localhost:3000` for the browser demo or check the API with:

```bash
curl http://localhost:3000/health
```

The complete setup and scenario walkthrough is in [docs/demo.md](docs/demo.md).

## Environment variables

| Variable                | Required | Purpose                                                  |
| ----------------------- | -------- | -------------------------------------------------------- |
| `PORT`                  | No       | HTTP port; defaults to `3000`                            |
| `GEMINI_API_KEY`        | Yes      | Authenticates Gemini requests                            |
| `GEMINI_MODEL`          | No       | Gemini model; defaults to `gemini-2.5-flash`             |
| `GOOGLE_CLIENT_EMAIL`   | Yes      | Google service-account email                             |
| `GOOGLE_PRIVATE_KEY`    | Yes      | Service-account private key with newlines stored as `\n` |
| `GOOGLE_SPREADSHEET_ID` | Yes      | Spreadsheet containing `Contacts` and `Call Log`         |
| `GOOGLE_CALENDAR_ID`    | Yes      | Calendar used for availability and appointments          |
| `TELEGRAM_BOT_TOKEN`    | Yes      | Telegram bot used for owner notifications                |
| `TELEGRAM_CHAT_ID`      | Yes      | Telegram owner-notification destination                  |

Enable the Google Sheets and Google Calendar APIs. Share both configured resources with
`GOOGLE_CLIENT_EMAIL`; the Calendar must allow the service account to change events. An API key
alone cannot authorize these writes.

## HTTP API

Send a customer message to `POST /conversations/messages` with `X-Business-Id` as trusted request
metadata:

```bash
curl --request POST http://localhost:3000/conversations/messages \
  --header 'Content-Type: application/json' \
  --header 'X-Business-Id: maple-street-dog-grooming' \
  --data '{"callerPhone":"+14155550100","message":"What time do you open?"}'
```

The body accepts `message`, optional `callerPhone`, and optional `conversationId`. A response
contains `conversationId`, `status`, and `reply`, plus `appointmentId` when applicable. Send the
returned conversation ID with later messages. Phase 1 state is in memory and is lost on restart.

`callerPhone` is optional channel metadata. Customer-specific operations separately collect and
confirm the preferred contact phone before reading or changing appointment data.

## Architecture

- `src/models/` owns validated domain state.
- `src/services/` contains business use cases and provider adapters.
- `src/controllers/` validates HTTP input and creates responses.
- `src/routes/` maps URLs to controllers.
- `src/app/` composes dependencies for each configured business.
- `src/http/` owns Express and server lifecycle behavior.
- `src/config/` centralizes application and business configuration.
- `public/` contains the dependency-free browser demo.
- `.agents/skills/program-flow/references/requirements.md` is the behavior source of truth.

The LLM only interprets natural language into validated fields. Deterministic services own business
rules, confirmations, availability, and external writes. Google and Telegram SDKs stay behind
small application boundaries so tests use fakes rather than live services.

## Commands

- `npm run dev` starts the development server with reloads.
- `npm run build` compiles TypeScript into `dist/`.
- `npm start` runs the compiled server.
- `npm test` runs the tests.
- `npm run check` runs formatting, linting, type checking, and tests.

## Phase 1 limitations

- Conversations and duplicate-operation guards are process-local and do not survive a restart.
- Production multi-instance deployment would require durable conversation and idempotency storage.
- Holiday hours, payment collection, automatic refunds, and voice-provider integration are outside
  Phase 1.
