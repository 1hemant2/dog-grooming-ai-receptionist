# Maple Street Receptionist

Phase 1 of the ProcIndex take-home: a text-based AI receptionist for a dog grooming shop.

## Requirements

- Node.js 22 or newer
- npm 10 or newer

## Setup

```bash
npm install
cp .env.example .env
npm run dev
```

The server listens on `http://localhost:3000`. Check it with:

```bash
curl http://localhost:3000/health
```

For live Google Sheets persistence, enable the Google Sheets API, create a service account, and
share the spreadsheet with that account's email address. Set `GOOGLE_CLIENT_EMAIL` and
`GOOGLE_PRIVATE_KEY` in `.env`; store newline characters in the private key as `\\n`. An API key
alone cannot authorize writes to a private spreadsheet.

Start or continue a conversation with:

```bash
curl --request POST http://localhost:3000/conversations/messages \
  --header 'Content-Type: application/json' \
  --header 'X-Business-Id: maple-street-dog-grooming' \
  --data '{"callerPhone":"+14155550100","message":"What time do you open?"}'
```

The response includes a `conversationId`. Include it in the JSON body of later messages. A UI or
voice adapter may provide its own conversation ID with the first message. Phase 1 keeps conversation
state in memory, so IDs stop working when the server restarts. `callerPhone` is optional for initial
text messages. Customer-specific operations require a confirmed `contactPhone` before booking or
appointment lookup.

## Commands

- `npm run dev` starts the development server with reloads.
- `npm run build` compiles TypeScript into `dist/`.
- `npm start` runs the compiled server.
- `npm test` runs the tests.
- `npm run check` runs formatting, linting, type checking, and tests.

## Current structure

- `src/models/` contains business and conversation state.
- `src/controllers/` validates requests and coordinates model operations.
- `src/routes/` maps Express routes to controllers.
- `src/config/` contains application and business configuration values.
- `src/http/` contains Express setup and HTTP server lifecycle behavior.
- `.agents/skills/program-flow/references/requirements.md` contains the agreed behavior.

Domain objects, use cases, and external adapters will be added only when their behavior is implemented.
