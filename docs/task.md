# Implementation Tasks

This is the implementation backlog. The approved Phase 1 behavior remains in
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
- [x] T07 — Appointment lookup, rescheduling, and cancellation
- [x] T08 — Late arrivals, complaints, and human handoff
- [x] T09 — LLM interpretation and conversation orchestration
- [x] T10 — Reliability and safety checks
- [ ] T11 — Demo data, end-to-end verification, and documentation
- [x] T12 — Vapi contract, configuration, and security
- [ ] T13 — Vapi conversation turn adapter
- [ ] T14 — Vapi call lifecycle and delivery safety
- [ ] T15 — Voice end-to-end verification and documentation

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
- `Call Log` records every completed conversation, all handled intents, and human-handoff context.
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
- Contacts are updated after the Calendar result, and the final Call Log row includes the handled intents and outcome.
- Conflicts, write failures, and duplicate submissions are tested.

## T07 — Appointment lookup, rescheduling, and cancellation

Status: Complete

Goal: Safely find and change an existing appointment.

Decision:

- Use an injected `OwnerNotifier` boundary for owner notifications.
- Confirm identity with the contact phone, customer name, and pet name before changes.

Complete when:

- Lookup uses the confirmed contact phone and confirms customer and pet names.
- Requests inside the 24-hour threshold go to a human without changing Calendar.
- Rescheduling checks and reconfirms the new slot before moving the appointment.
- Cancellation requires explicit customer confirmation.
- Successful changes notify the owner and are included in the final Call Log row.
- Missing, ambiguous, stale, and failed Calendar operations are tested.

## T08 — Late arrivals, complaints, and human handoff

Status: Complete

Goal: Handle cases that require notification or human judgment.

Decision:

- Use the Telegram Bot API through the injected `OwnerNotifier` boundary.
- Read the Telegram bot token and target chat ID from central application configuration.

Complete when:

- Delays under 15 minutes are recorded and sent to the owner.
- Delays of 15 minutes or more become `needs_human`.
- Routine operational complaints with a deterministic answer are handled by the agent and recorded as completed.
- Refund and charge decisions always go to a human.
- Safety, injury, aggression, and compensation complaints receive immediate handoff.
- Other unresolved complaints create an owner callback request.
- Responses acknowledge concerns without promising fault, refunds, or outcomes.

## T09 — LLM interpretation and conversation orchestration

Status: Complete

Goal: Connect natural-language customer messages to tested application behavior.

Decision:

- Use Gemini as the initial LLM provider through a provider-neutral `MessageInterpreter` adapter.
- Read the API key and model name from central application configuration.
- Keep provider-specific SDK calls outside the conversation orchestrator so another provider can replace Gemini later.

Complete when:

- The LLM produces validated structured intents and extracted fields.
- Deterministic application code owns business rules and external writes.
- The selected business configuration and current conversation state provide context.
- Unsupported, ambiguous, or invalid model output is handled safely.
- The LLM cannot call Google adapters or bypass confirmation rules directly.
- Tests use a fake interpreter and include malformed model output.

## T10 — Reliability and safety checks

Status: Complete

Goal: Make external writes and failure behavior safe enough for demonstration and review.

Decisions:

- Use process-local duplicate-operation guards because Phase 1 keeps conversation state in memory.
- The duplicate guards do not survive a restart; a multi-instance production service would use durable idempotency storage.
- Keep the Calendar appointment identifier when a later persistence or notification step fails.
- Apply one central timeout to outbound provider requests.

Complete when:

- Calendar writes are protected against duplicate processing.
- A final availability check prevents stale booking and rescheduling decisions.
- Partial failures between Calendar and Sheets are visible and recoverable.
- Logs contain useful request and outcome identifiers without secrets or unnecessary personal data.
- Timeouts and external failures produce controlled responses and preserve handoff context.

## T11 — Demo data, end-to-end verification, and documentation

Status: Pending

Goal: Deliver a reproducible Phase 1 demonstration.

Decisions:

- Serve a dependency-free browser UI from the existing Express application.
- Keep demo Calendar events and Sheet rows as manually prepared demo data so the reviewer can see the live records.

Pending live verification:

- Prepare the demo Calendar events and Sheet rows, then record the Phase 1 walkthrough.

Complete when:

- A small browser UI demonstrates the text conversation through the HTTP API.
- Calendar seed data demonstrates conflicts and rescheduling.
- The Google Sheet contains `Contacts` and `Call Log` tabs with documented columns.
- End-to-end tests or a repeatable demo cover every defined conversation flow.
- Setup, environment variables, architecture, assumptions, and demo commands are documented.
- A clean install passes formatting, linting, type checking, tests, and build.
- The final diff contains no secrets, generated output, dead code, or unfinished placeholders.

## Phase 2 direction

- Vapi owns telephony, speech-to-text, and text-to-speech.
- Add Vapi at the transport boundary. Keep the conversation orchestrator, business services, Calendar, Sheets, and Telegram integrations unchanged.
- Use the Vapi call ID as the stable external conversation ID.
- Resolve the business from trusted Vapi phone-number or assistant metadata, never from caller speech.
- Treat the caller's phone number as `callerPhone` channel metadata. Continue to collect and confirm `contactPhone` before customer-specific operations.

## T12 — Vapi contract, configuration, and security

Status: Complete

Goal: Define and secure the boundary between Vapi and the application.

Decisions:

- Use a Vapi API Request Tool to call a dedicated application adapter while the existing backend remains the dialogue engine.
- Demonstrate an inbound phone call first; browser calling can be added later without changing the application boundary.
- Use an ngrok HTTPS tunnel during local development.
- Authenticate Vapi with a Bearer credential stored as `VAPI_SERVER_TOKEN`.
- Map the trusted Vapi phone number to a configured business using `VAPI_PHONE_NUMBER` and `VAPI_BUSINESS_ID`.

Complete when:

- Accepted Vapi request types and response shapes are represented with small application-owned types.
- Vapi credentials and trusted identity mappings are read through central application configuration.
- Requests are authenticated before their payload is processed.
- Call ID, caller number, and called number or assistant identity are validated and converted into trusted conversation context.
- Unknown businesses, malformed payloads, missing call IDs, and unauthenticated requests return controlled errors without invoking the orchestrator.
- Tests cover valid and invalid configuration, authentication, and identity mapping.

## T13 — Vapi conversation turn adapter

Status: Pending

Goal: Pass each caller utterance to the existing conversation handler and return its reply to Vapi.

Expected flow:

1. Vapi sends trusted call metadata containing the call ID, caller number, and called number or assistant identity.
2. The adapter resolves the business and creates or resumes the matching conversation.
3. Each final customer utterance is passed to the existing conversation handler.
4. Fast responses are returned without playing an unnecessary waiting message.
5. If the application has not responded after approximately 2.5 seconds, Vapi tells the caller, "I’m checking that for you. One moment, please."
6. If processing is still running after approximately 7 seconds, Vapi tells the caller, "Thanks for your patience. I’m still working on that."
7. When processing finishes, the adapter returns the receptionist's actual reply in the response format expected by Vapi.
8. Existing services continue to perform availability, booking, rescheduling, cancellation, persistence, and owner notification.

Latency behavior:

- Waiting messages are triggered by elapsed response time, not by duplicating or inspecting the orchestrator's internal Gemini decision.
- Keep the existing conversation orchestrator and its tested business behavior unchanged.
- Configure waiting messages in Vapi when the backend is invoked as a tool. If a custom-LLM adapter is selected, implement the same behavior with a small adapter-level timer and streamed response.
- Use an approximately 15-second voice request timeout and return a controlled failure message when it expires.
- Do not automatically retry conversation turns or operations that may write to Calendar, Sheets, or Telegram.
- Waiting messages improve the caller experience but do not count as completion of the requested operation.

Complete when:

- The existing text UI and `POST /conversations/messages` contract continue to work unchanged.
- Interpretation and provider failures produce a safe voice response without exposing internal errors.
- A response completed before the delay threshold does not play a waiting message.
- A delayed response plays the configured waiting message without interrupting, replacing, or changing the final receptionist reply.
- Timing logs include safe call and duration metadata without transcripts, phone numbers, credentials, or complete provider payloads.
- Adapter tests cover multi-turn state, response formatting, provider failures, and delayed-response timing.

## T14 — Vapi call lifecycle and delivery safety

Status: Pending

Goal: Finalize calls reliably despite retries, duplicate events, and overlapping requests.

Expected flow:

1. Events for one Vapi call are processed in order.
2. Duplicate utterances or tool calls reuse the existing result instead of repeating business actions.
3. When Vapi reports that the call ended, allow any in-progress turn to finish.
4. Finalize the existing conversation once so the Call Log is written.
5. Remove in-memory conversation state only after final persistence succeeds.

Failure behavior:

- A duplicate end-of-call event does not create another Call Log row.
- A failed Call Log write preserves conversation state for retry or human review.
- An end event cannot remove state while a turn or Calendar action is still processing.
- Calendar writes retain the existing duplicate-operation and partial-failure protections.

Complete when:

- Call termination writes one final Call Log row and removes conversation state without duplicate finalization.
- Tests cover duplicate delivery, event ordering, overlapping turns, repeated end events, and persistence failures.
- Existing browser idle cleanup and explicit end-conversation behavior still work.

## T15 — Voice end-to-end verification and documentation

Status: Pending

Goal: Deliver a reproducible Vapi voice demonstration using the completed backend integration.

Complete when:

- Vapi can conduct a multi-turn voice conversation using the existing receptionist behavior.
- At least one voice booking, rescheduling, and cancellation reaches the existing Calendar and Sheets integrations.
- A human-handoff case sends the existing Telegram owner notification.
- Ending the call produces one Call Log row containing the handled intents and final outcome.
- Turn latency and failure behavior are observed with safe operational logs.
- Setup documentation explains the Vapi assistant, phone or browser-call configuration, authentication, required environment variables, public HTTPS tunnel or deployment, and demonstration flow.
- No credentials, transcripts, recordings, phone numbers, or generated artifacts are committed.
- Formatting, linting, type checking, tests, and build pass.
