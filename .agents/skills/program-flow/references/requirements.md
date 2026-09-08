# Phase 1 Requirements and Conversation Flows

This document is the source of truth for Phase 1 behavior before implementation.

## Problem

Build a text-based AI receptionist for Maple Street Dog Grooming. It should handle supported customer requests, use reliable sources before answering, and hand off requests that require human judgment. Correct behavior matters more than speed, cost, or UI polish.

## Required integrations

- Google Calendar checks availability and creates or changes appointments.
- Google Sheets keeps one contact row per caller and records what happened in each conversation.

## Setup requirements

- Seed Calendar with appointments that can demonstrate conflicts and rescheduling.
- Create a Google Sheet with `Contacts` and `Call Log` tabs.
- Use TypeScript with Node.js and any LLM provider.

## Business defaults

- The shop has one groomer and handles one appointment at a time.
- Every service has a configured duration. Calendar availability must cover the complete service duration.
- Shop hours, timezone, services, durations, and starting prices come from configured shop information.
- A phone number identifies a contact. Confirm the customer's name and pet name when finding an existing appointment.
- Prices are estimates. The final price may depend on the dog's size, coat condition, behavior, and time required.
- The receptionist may book, reschedule, or cancel appointments, but it does not take payments, issue refunds, or apply fees.
- Automated cancellations and rescheduling require at least 24 hours' notice. Requests inside 24 hours go to a human.
- Delays shorter than 15 minutes are recorded and sent to the business owner. Delays of 15 minutes or more go to a human.
- Current rabies vaccination proof is required before grooming. Unclear vaccination cases go to a human.
- Do not reject a dog based only on breed. Safety-sensitive cases involving size, health, aggression, or severe anxiety go to a human.

## Shared conversation lifecycle

1. Identify what the customer wants.
2. Collect only the information needed for that request.
3. Check the relevant source of truth: shop information, policy, or Calendar.
4. Answer the question, propose an available option, or hand the request to a human.
5. Before changing Calendar, confirm the customer, pet, service, date, and time.
6. Check Calendar again immediately before writing to avoid a stale availability result.
7. Perform the approved Calendar action once and verify that it succeeded.
8. Update the contact and add a call-log entry in Sheets.
9. Tell the customer what happened and ask whether they need anything else.

If a required lookup fails, the receptionist must not guess. It should explain that it cannot complete the request and preserve enough context for a human to continue.

## Defined conversation flows

### Service enquiry and booking

1. Check whether the shop offers every requested service.
2. If none of the requested services are offered, explain that the shop does not provide them.
3. If only some services are offered, state what is available and ask whether the customer wants to continue with those services.
4. Collect the pet's name, breed or mix, size, and any health or behavior information needed for safe scheduling.
5. Check the requested appointment time only after the service and required duration are known.
6. If the time is available, collect the customer's name and phone number, confirm the details, and book it.
7. If the time is unavailable, offer the nearest available time on the same day, then the next day. Prefer times closest to the customer's requested time.
8. Book only after the customer accepts an offered time.

### Pricing enquiry

1. Find the starting price using the requested service and the dog's size.
2. Give the starting-price estimate and explain which factors may change the final price.
3. Do not promise a final price when required information is missing.
4. Hand off unusual pricing questions or disputed charges to a human.

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
2. Acknowledge the complaint without promising an outcome.
3. Hand off safety concerns, injuries, aggressive behavior, or requests for compensation immediately.
4. For other complaints, record a callback request for the business owner.

## Sheets records

### Contacts

Keep one row per phone number with the customer name, pet name, breed or mix, size, vaccination status, notes, and last-contact time.

### Call Log

Keep one row per conversation with the timestamp, phone number, intent, outcome, appointment identifier, and human-handoff summary when applicable.

## Open decisions

- Exact shop hours, timezone, holiday closures, services, durations, and starting prices
- Additional vaccination requirements and acceptable forms of proof
- The size or safety conditions that always require human review
- How the business owner receives notifications and human handoffs
- How far to search when no suitable appointment exists today or the next day
