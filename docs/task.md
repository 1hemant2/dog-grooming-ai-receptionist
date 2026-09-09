# Phase 1 Tasks

This is the implementation backlog for Phase 1. The approved behavior remains in
`.agents/skills/program-flow/references/requirements.md`.

## Working agreement

- Keep only one task in progress.
- Before starting a task, confirm any decision listed in that task.
- Implement only the scope of the active task.
- A task is complete only when its behavior is tested and `npm run check` and `npm run build` pass.
- Update this file when a task starts or finishes.
- Use `[ ]` for pending, `[~]` for in progress, and `[x]` for complete.

## Progress

- [x] T00 — Repository foundation
- [x] T01 — Conversation entry contract and tenant context
- [x] T02 — Conversation and domain model
- [x] T03 — Informational enquiries
- [x] T04 — Google Sheets persistence
- [x] T05 — Calendar availability
- [x] T06 — Appointment booking
- [ ] T07 — Appointment lookup, rescheduling, and cancellation
- [ ] T08 — Late arrivals, complaints, and human handoff
- [ ] T09 — LLM interpretation and conversation orchestration
- [ ] T10 — Reliability and safety checks
- [ ] T11 — Demo data, end-to-end verification, and documentation

## T00 — Repository foundation

Status: Complete

- TypeScript and Node.js project setup.
- ESLint, Prettier, type checking, tests, and build commands.
- Health endpoint and graceful shutdown.
- Typed business configuration collection and lookup by business ID.

## T01 — Conversation entry contract and tenant context

Status: Complete

Goal: Define how a customer message enters the application and how its business is identified.

Decisions made:

- Use the `POST /conversations/messages` HTTP JSON endpoint.
- Read the trusted business context from `X-Business-Id`, outside customer-written text.
- Generate a UUID for the first message and require it to resume a conversation.
- Keep Phase 1 conversation state in memory.

Complete when:

- The input and output contract is documented and validated.
- Each request has a trusted business ID and message. A conversation ID is generated or provided, and a caller phone number may be provided.
- A text conversation may start without a caller phone number, but customer-specific operations collect and validate a confirmed contact phone before continuing.
- Unknown businesses and invalid requests return controlled errors.
- Customer-written text cannot select another business.
- Boundary tests cover valid and invalid requests.

## T02 — Conversation and domain model

Status: Complete

Goal: Represent receptionist behavior without depending on HTTP, an LLM, Google, or another framework.

Complete when:

- Domain types cover customer, pet, service, appointment, intent, conversation state, and outcome.
- Expected outcomes include answered, needs-information, completed, unavailable, and needs-human.
- External operations are represented by small Calendar, Contacts, Call Log, and message-interpreter interfaces.
- Important values and state transitions are validated when created.
- Unit tests cover valid state, invalid state, and transitions.

## T03 — Informational enquiries

Status: Complete

Goal: Answer questions that only need the selected business configuration.

Flows:

- Services and unsupported services.
- Starting prices and pricing disclaimers.
- Business hours and Sunday closure.
- Breed and size suitability.
- Rabies vaccination requirements.

Complete when:

- Answers come from `BusinessConfig`, not hard-coded Maple Street values.
- Missing or safety-sensitive information produces a follow-up question or human handoff.
- Breed alone never causes rejection.
- Unit tests cover each flow and its important edge cases.

## T04 — Google Sheets persistence

Status: Complete

Goal: Persist contacts and conversation outcomes behind domain interfaces.

Decision:

- Use Google service-account credentials from `GOOGLE_CLIENT_EMAIL` and `GOOGLE_PRIVATE_KEY`.
- Keep spreadsheet IDs and tab names in the selected `BusinessConfig`.
- Use a fake spreadsheet client in tests and the Google Sheets client for live persistence.

Complete when:

- A contact is found and updated by phone number without creating duplicates.
- `Contacts` stores the required customer and pet fields.
- `Call Log` records every completed conversation and human-handoff context.
- Business-specific spreadsheet configuration is used.
- Google failures return controlled application errors without losing conversation context.
- Adapter tests use a fake Google boundary and do not call the live API.

## T05 — Calendar availability

Status: Complete

Goal: Find valid appointment slots using business rules and Google Calendar data.

Decision:

- Use the existing Google service-account credentials with the Calendar event read/write scope.
- Keep the business-specific Calendar ID in `BusinessConfig`.
- Generate candidate start times in 30-minute increments.
- Use Luxon for timezone-aware date calculations and UTC conversion.

Complete when:

- Duration includes the service duration and the large-dog adjustment.
- Slots stay within business hours and exclude closed days.
- Existing appointments block their complete time range.
- Search covers seven days and prefers the nearest suitable time.
- Dogs over 100 lb and safety-sensitive cases require human review.
- Timezone handling is explicit and tested.
- Calendar read failures never produce guessed availability.

## T06 — Appointment booking

Status: Complete

Goal: Safely create a confirmed grooming appointment.

Decision:

- Keep booking orchestration separate from HTTP and LLM interpretation.
- Use the conversation ID and requested booking details as the Phase 1 duplicate key.

Complete when:

- Required customer, confirmed contact phone, pet, service, date, and time information is collected.
- The customer confirms the final details before any Calendar write.
- Availability is checked again immediately before creation.
- An accepted appointment is created once and its identifier is retained.
- Contacts and Call Log are updated after the Calendar result.
- Conflicts, write failures, and duplicate submissions are tested.

## T07 — Appointment lookup, rescheduling, and cancellation

Status: Pending

Goal: Safely find and change an existing appointment.

Complete when:

- Lookup uses the confirmed contact phone and confirms customer and pet names.
- Requests inside the 24-hour threshold go to a human without changing Calendar.
- Rescheduling checks and reconfirms the new slot before moving the appointment.
- Cancellation requires explicit customer confirmation.
- Successful changes notify the owner and are recorded in Call Log.
- Missing, ambiguous, stale, and failed Calendar operations are tested.

## T08 — Late arrivals, complaints, and human handoff

Status: Pending

Goal: Handle cases that require notification or human judgment.

Decision:

- Choose the Phase 1 owner-notification mechanism.

Complete when:

- Delays under 15 minutes are recorded and sent to the owner.
- Delays of 15 minutes or more become `needs_human`.
- Refund and charge decisions always go to a human.
- Safety, injury, aggression, and compensation complaints receive immediate handoff.
- Other complaints create an owner callback request.
- Responses acknowledge concerns without promising fault, refunds, or outcomes.

## T09 — LLM interpretation and conversation orchestration

Status: Pending

Goal: Connect natural-language customer messages to tested application behavior.

Decision:

- Choose the LLM provider and model.

Complete when:

- The LLM produces validated structured intents and extracted fields.
- Deterministic application code owns business rules and external writes.
- The selected business configuration and current conversation state provide context.
- Unsupported, ambiguous, or invalid model output is handled safely.
- The LLM cannot call Google adapters or bypass confirmation rules directly.
- Tests use a fake interpreter and include malformed model output.

## T10 — Reliability and safety checks

Status: Pending

Goal: Make external writes and failure behavior safe enough for demonstration and review.

Complete when:

- Calendar writes are protected against duplicate processing.
- A final availability check prevents stale booking and rescheduling decisions.
- Partial failures between Calendar and Sheets are visible and recoverable.
- Logs contain useful request and outcome identifiers without secrets or unnecessary personal data.
- Timeouts and external failures produce controlled responses and preserve handoff context.

## T11 — Demo data, end-to-end verification, and documentation

Status: Pending

Goal: Deliver a reproducible Phase 1 demonstration.

Complete when:

- A small browser UI demonstrates the text conversation through the HTTP API.
- Calendar seed data demonstrates conflicts and rescheduling.
- The Google Sheet contains `Contacts` and `Call Log` tabs with documented columns.
- End-to-end tests or a repeatable demo cover every defined conversation flow.
- Setup, environment variables, architecture, assumptions, and demo commands are documented.
- A clean install passes formatting, linting, type checking, tests, and build.
- The final diff contains no secrets, generated output, dead code, or unfinished placeholders.
