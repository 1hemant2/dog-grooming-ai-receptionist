# Phase 1 Requirements and Conversation Flows

This document is the source of truth for Phase 1 behavior before implementation.

## Problem

Build a text-based AI receptionist for Maple Street Dog Grooming. It should handle supported customer requests, use reliable sources before answering, and hand off requests that require human judgment. Correct behavior matters more than speed, cost, or UI polish.

## Required integrations

- Google Calendar checks availability and creates or changes appointments.
- Google Sheets keeps one contact row per caller and records what happened in each conversation.
- Phase 1 uses Gemini as the initial LLM provider through the `MessageInterpreter` boundary. Provider-specific SDK calls stay inside an adapter so another provider can replace it without changing business services or orchestration.
- Gemini credentials use `GEMINI_API_KEY`; `GEMINI_MODEL` selects the model and defaults to the configured Phase 1 model.

## Setup requirements

- Seed Calendar with appointments that can demonstrate conflicts and rescheduling.
- Create a Google Sheet with `Contacts` and `Call Log` tabs.
- Use TypeScript with Node.js and any LLM provider.

## Phase 1 conversation interface

- Customer messages enter through `POST /conversations/messages` with JSON content.
- `X-Business-Id` carries the business identity as trusted transport metadata for the Phase 1 demo. It is never extracted from customer-written text. A production phone adapter would derive the same context from the number called or authenticated integration.
- The body contains `message`, an optional `callerPhone`, and an optional `conversationId`.
- When provided, caller phone numbers use E.164 format.
- `callerPhone` is channel metadata and is not automatically treated as the customer's preferred contact number.
- A trusted client may provide a conversation ID with the first message, which supports IDs created by a voice provider or UI. If no ID is provided, the server creates a UUID. The same ID is returned and used for later messages.
- Conversation state is kept in memory for Phase 1 and is lost when the process restarts.
- A conversation cannot be resumed under another business or caller phone number.
- A conversation that starts without a phone number can be resumed by its business and conversation ID. When a phone number is later provided, it becomes associated with that conversation and must match on subsequent requests.
- After a call ends and its required Call Log data is saved, remove its in-memory conversation state. Do not remove the state if it must be preserved for a failed write or human handoff.
- Successful responses contain `conversationId`, `status`, and `reply`. They also contain `appointmentId` when an appointment was created or changed, including a partial failure that requires human review.

## Phase 1 demonstration UI

- A small browser UI demonstrates the text receptionist through the existing HTTP endpoint.
- The UI may collect a caller phone number for the conversation and keeps it after it is provided.
- The UI asks for and confirms a `contactPhone` before customer-specific operations such as booking, rescheduling, cancellation, or appointment lookup.
- The UI sends the business ID as trusted request metadata, not as customer-written message content.
- After the first response, the UI stores the returned `conversationId` and sends it with later messages.
- The UI displays the conversation replies and request status so the main Phase 1 flows can be demonstrated manually.
- The UI provides an End conversation action. Ending a conversation saves one final Call Log row and then removes the in-memory conversation state.
- Pressing Enter sends the message. Shift+Enter inserts a new line in the message box.
- The UI does not contain business rules; it only collects input, calls the API, and displays results.

## Business defaults

- Business settings are stored as a collection keyed by a stable business ID. Maple Street Dog Grooming is the initial configured business.
- Resolve the business at the start of each customer conversation using trusted transport metadata, such as the number called or authenticated request context. Do not accept a business identity from customer-written text.
- If the business cannot be resolved, do not answer from another business's configuration or access its Calendar or Sheets data.
- The shop has one groomer and handles one appointment at a time.
- Every service has a configured duration. Calendar availability must cover the complete service duration.
- Shop hours, timezone, services, durations, and starting prices come from configured shop information.
- A confirmed `contactPhone` identifies a contact. Confirm the customer's name and pet name when finding an existing appointment.
- Maple Street accepts a 10-digit US contact number in natural customer speech and normalizes it to E.164 with the `+1` country code before confirmation and persistence.
- Prices are estimates. The final price may depend on the dog's size, coat condition, behavior, and time required.
- The receptionist may book, reschedule, or cancel appointments, but it does not take payments, issue refunds, or apply fees.
- Automated cancellations and rescheduling require at least 24 hours' notice. Requests inside 24 hours go to a human.
- Delays shorter than 15 minutes are recorded and sent to the business owner. Delays of 15 minutes or more go to a human.
- Current rabies vaccination proof is required before grooming. Unclear vaccination cases go to a human.
- Do not reject a dog based only on breed. Safety-sensitive cases involving size, health, aggression, or severe anxiety go to a human.
- The shop is open Monday through Saturday from 9:00 AM to 5:00 PM and closed on Sunday.
- The shop timezone is `America/Los_Angeles`. No special holiday hours are defined for Phase 1.
- Bath starts at $45 and takes 60 minutes.
- Bath includes shampoo and conditioner, blow-drying, brushing, ear cleaning, and a nail trim.
- Bath and Trim starts at $70, takes 90 minutes, and adds light trimming around the face, feet, and sanitary areas to the Bath service.
- Full Groom starts at $95, takes 120 minutes, and adds a complete haircut and style to the Bath service.
- Dogs from 71 to 100 lb add 30 minutes to the service duration. Dogs over 100 lb require human review.
- Aggression, severe anxiety, active illness, or injury requires human review.
- Phase 1 handoff records `needs_human` in the Call Log and tells the customer that the owner will call back.
- Phase 1 owner notifications use the Telegram Bot API. The bot token and target chat ID come from application configuration and are never hard-coded or accepted from customer messages.
- A conversation that has no new message for the configured idle timeout is finalized automatically. The default Phase 1 idle timeout is 15 minutes.
- Availability searches cover the next seven days. If no suitable slot exists, ask for another date range or create a callback request.

## Shared conversation lifecycle

1. Resolve the business from trusted request metadata and load its configuration.
2. Identify what the customer wants.
3. Collect only the information needed for that request. For customer-specific operations, collect and confirm a `contactPhone`.
4. When required information is missing, ask for one item at a time and preserve facts already supplied earlier in the conversation.
5. Preserve active-request facts as structured conversation state. The message interpreter extracts the latest answer instead of reconstructing every fact from the complete transcript.
6. Parse expected short answers such as phone numbers, names, weights, dates, times, and confirmations locally when they are unambiguous. Use the LLM when the answer cannot be safely interpreted locally. Use the LLM to classify context-dependent replies, such as whether the customer rejected all recently offered appointment times, instead of enumerating possible wording with regular expressions.
7. Accept natural appointment dates such as `11th September`, relative dates such as `tomorrow`, and common spelling mistakes such as `tommorow`; resolve them in the business timezone.
8. During an active booking, answer a service-information side question without discarding the booking state, then resume by asking for the next missing booking field.
9. During an active request, preserve the request when the customer asks an unrelated question. Explain the receptionist's supported scope and return to the next missing field.
10. When the customer explicitly says reset, start over, or begin a new request, clear only the active request and pending question while preserving the conversation and confirmed contact phone.
11. When the customer clearly starts another request, retain the conversation but do not reuse details that only belonged to the earlier request.
12. Check the relevant source of truth for that business: shop information, policy, or Calendar.
13. Answer the question, propose an available option, or hand the request to a human.
14. Before changing Calendar, confirm the customer, pet, service, date, and time.
15. Check Calendar again immediately before writing to avoid a stale availability result.
16. Perform the approved Calendar action once and verify that it succeeded.
17. Update the contact record in the business's Sheets records as needed.
18. Tell the customer what happened and ask whether they need anything else.

Customer-facing questions use conversational language and refer to known details, such as the pet's name, when helpful. Internal terms such as `configured service`, diagnostic reasons, and orchestration instructions are not shown to customers. Customer-facing appointment dates and times are formatted in the business timezone; UTC remains an internal Calendar and persistence representation.

When the customer ends the conversation, save all handled intents, the final outcome, and conversation
metadata to one Call Log row before deleting the in-memory conversation. If the Call Log write fails,
preserve the conversation so it can be retried or handed to a human.

If the customer does not explicitly end the conversation, finalize it after the idle timeout using the
same Call Log and cleanup flow. Do not write a second row if an explicit end or timeout finalization
has already succeeded.

If a required lookup fails, the receptionist must not guess. It should explain that it cannot complete the request and preserve enough context for a human to continue.

For Phase 1, duplicate Calendar-write protection is process-local and shares the result of a repeated booking, rescheduling, or cancellation request. It does not survive a restart; a production multi-instance deployment requires durable idempotency storage. Outbound provider requests use a configured timeout. If Calendar succeeds but a later persistence or notification step fails, preserve the appointment identifier, return `needs_human`, and do not blindly repeat the Calendar write.

Operational timing logs record request start, response time, elapsed milliseconds, conversation ID, and safe request-size metadata. Gemini timing logs also record provider duration, prompt character count, and conversation history count. Do not log customer message text, phone numbers, prompts, credentials, or other secrets.

Gemini receives only a bounded recent-history window plus the current active intent and expected answer type. This keeps later turns responsive and reduces confusion from completed parts of a long conversation.

## Defined conversation flows

### Service enquiry and booking

1. Check whether the shop offers every requested service.
2. When the customer asks what a specific service includes, answer from that service's configured inclusions and include its duration and starting price.
3. If none of the requested services are offered, explain that the shop does not provide them.
4. If only some services are offered, state what is available and ask whether the customer wants to continue with those services.
5. Collect the pet's name, breed or mix, size, and any health or behavior information needed for safe scheduling.
6. Check the requested appointment time only after the service and required duration are known.
7. If the time is available, collect the customer's name and confirmed `contactPhone`, confirm the details, and book it.
8. If the time is unavailable, offer the nearest available time on the same day, then the next day. Prefer times closest to the customer's requested time.
9. If none of the offered alternatives work, ask for another date or time and search again. If the customer says the original unavailable time is their only option, stop repeating alternatives and send the request to the owner for review.
10. If no suitable time exists in the search window, collect the confirmed callback details, notify the owner, and tell the customer that the owner will call back.
11. Book only after the customer accepts an offered time.

### Pricing enquiry

1. Find the starting price using the requested service and the dog's size.
2. Give the starting-price estimate and explain which factors may change the final price.
3. Do not promise a final price when required information is missing.
4. Dogs from 71 through 100 lb remain eligible for an estimate and require the configured additional time.
5. Dogs above 100 lb require human review. Explain that the dog's size needs groomer review before giving a price or booking. Before notifying the owner, collect and confirm a callback phone number, then collect the customer and pet names when they are missing. Do not provide an automatic price or booking.
6. After the callback details are collected, notify the owner, tell the customer that the owner will call back, and keep the conversation available until it ends.
7. When the conversation ends, write one Call Log row with `needs_human` and `callbackRequested: true`.
8. If the customer asks to be connected again after this handoff, confirm that the request is already with the owner without sending a duplicate notification.
9. Hand off unusual pricing questions or disputed charges to a human.

### Business-hours enquiry

1. Answer using the configured shop hours and timezone.
2. Mention closures when they affect the requested date.
3. Do not infer special or holiday hours that are not configured.

### Breed enquiry

1. Check whether the requested service supports the dog's size and coat needs.
2. Do not reject the dog based only on breed.
3. Ask about relevant health, behavior, aggression, or anxiety concerns.
4. Hand off when safe handling or service suitability is uncertain.

### Vaccination enquiry

1. State that current rabies vaccination proof is required before grooming.
2. Check the shop's vaccination guidance for any additional question.
3. Answer only when the guidance covers the customer's question.
4. Hand off when the answer or proof requirement is unclear.

### Customer running late

1. Identify the customer and appointment.
2. Ask for the expected arrival time.
3. For a delay shorter than 15 minutes, keep the appointment, record the delay, and notify the business owner.
4. For a delay of 15 minutes or more, hand off because the remaining schedule requires human judgment.
5. Pass the appointment details and expected arrival time to the human.

### Reschedule appointment

1. Identify the customer and existing appointment.
2. If the appointment starts in less than 24 hours, do not change Calendar and hand off to a human.
3. Otherwise, ask for the customer's preferred new date and time.
4. If the requested time is available, confirm it, move the appointment, and notify the business owner.
5. If it is unavailable, offer the nearest available time before or after the requested time.
6. Move the appointment only after the customer accepts an alternative.
7. Record the outcome in Sheets.

### Cancel appointment

1. Identify the customer and existing appointment.
2. If the appointment starts in less than 24 hours, do not change Calendar and hand off to a human.
3. Otherwise, confirm that the customer wants to cancel.
4. Cancel only after confirmation, notify the business owner, and record the outcome in Sheets.

### Refund or charge complaint

1. Ask for the customer, appointment, disputed charge, and reason.
2. Record the complaint without admitting fault or promising compensation.
3. If the complaint concerns grooming quality and is reported within 48 hours, note that a human may review a corrective groom.
4. Hand off every refund or charge decision to a human with the collected context.

### Other complaint

1. Record the complaint and relevant customer details in Sheets.
2. If the complaint is a routine operational concern with a clear, known response, answer it and record the conversation as completed without a callback.
3. Acknowledge unresolved complaints without promising an outcome.
4. Hand off safety concerns, injuries, aggressive behavior, or requests for compensation immediately.
5. For other unresolved complaints, record a callback request for the business owner.

## Sheets records

### Contacts

Keep one row per confirmed `contactPhone` with the customer name, pet name, breed or mix, size, vaccination status, notes, and last-contact time.
Persist collected callback contact details before notifying the owner when a human handoff requires a callback.

### Call Log

Keep one row per conversation with the timestamp, conversation ID, `callerPhone` when available, confirmed `contactPhone` when collected, all handled intents in conversation order, the final outcome, appointment identifier, and human-handoff summary when applicable.
Build the human-readable outcome summary from deterministic conversation facts and the final outcome. Do not make an extra LLM request only to summarize the conversation.
