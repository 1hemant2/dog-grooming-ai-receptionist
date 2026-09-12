# Voice integration setup

This guide covers the two voice integrations: LiveKit browser voice first, followed by the Vapi phone assistant. Both use the existing receptionist backend for conversation state, business rules, Calendar, Sheets, Telegram, and Call Log persistence.

## LiveKit browser voice

This setup adds a local browser voice demo without replacing the existing text or Vapi paths. LiveKit transports microphone and speaker audio, LiveKit Inference provides speech recognition and speech synthesis, and the existing application remains responsible for the receptionist behavior.

### Configure LiveKit Cloud

Create a LiveKit Cloud project and copy its URL, API key, and API secret into the local `.env` file:

```text
LIVEKIT_URL=wss://<project>.livekit.cloud
LIVEKIT_API_KEY=<project-api-key>
LIVEKIT_API_SECRET=<project-api-secret>
LIVEKIT_AGENT_NAME=maple-street-receptionist
```

The backend owns the voice room connection and its conversation handler in the same Node process. Old `LIVEKIT_BACKEND_URL` and `LIVEKIT_BACKEND_TOKEN` entries can be removed from existing environment files.

The voice session uses LiveKit Inference with:

- STT: `deepgram/nova-3` with `en-IN` language guidance for Indian English.
- TTS: `inworld/inworld-tts-2` with the `Ashley` voice.
- Turn detection: STT end-of-utterance events. Completed turns are delivered to `BackendVoiceAgent.onUserTurnCompleted`, which calls the local conversation handler.
- Interruptions are disabled for the demo; wait until the receptionist finishes speaking before answering.

These model requests go through LiveKit Inference, so no separate Deepgram or Inworld key is needed in this application. Check the current LiveKit Cloud plan before a longer demo.

### Run the LiveKit demo

Start the application in one terminal:

```bash
npm run dev
```

Open `http://localhost:3000`, click **Start voice**, allow microphone access, and speak. The browser requests `/livekit/token`. The backend joins the room directly as the voice participant before returning the customer's room token. It uses LiveKit's `Room` and `AgentSession` primitives without `AgentServer`, worker registration, agent dispatch, or job subprocesses.

Each completed customer utterance calls `LiveKitConversationAdapter.handleTurn()` directly. The same conversation store and orchestrator handle chat and voice. The reply is synthesized and played back in the browser. Click **Stop voice** or **End conversation** to finalize the conversation and write one Call Log entry. Application shutdown closes the active voice sessions and finalizes their conversations.

Stop any old `npm run livekit:agent` terminal before using this version. The worker scripts and `/livekit/conversations/messages` and `/livekit/events` routes are no longer part of this integration.

### LiveKit deployment notes

The backend needs outbound access to LiveKit Cloud and LiveKit Inference. Browser microphone capture requires localhost or HTTPS. API credentials remain on the server; the browser receives only its room-scoped participant token. Conversation state remains process-local and is lost on restart, as in the text demo.

The application serves the browser SDK locally at `/vendor/livekit`, so the demo does not depend on a third-party CDN at runtime.

## Vapi phone assistant

This setup connects a Vapi phone assistant to the existing receptionist backend. Vapi handles speech; the application remains responsible for conversation state, business rules, Calendar, Sheets, Telegram, and final Call Log persistence.

### Start the local application

Provide these environment variables through the local environment or the launch mechanism used by the developer:

```text
VAPI_SERVER_TOKEN=<the same bearer token configured in Vapi>
VAPI_PHONE_NUMBER=<the Vapi phone number in E.164 format>
VAPI_BUSINESS_ID=maple-street-dog-grooming
```

Start the application with `npm run dev` and confirm that `GET /health` returns a healthy response.

### Start the HTTPS tunnel

The Vapi dashboard requires an HTTPS endpoint. For local development, forward the application port to a claimed ngrok dev domain:

```bash
ngrok http 3000 --url https://<your-ngrok-domain> --log=stdout
```

Keep the application and tunnel running during the call. The durable hostname is reusable, but the local process still has to be online.

### Configure the Vapi API Request Tool

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

Extract `reply` as a required string and `endCall` as an optional boolean. The assistant should speak `reply` exactly once. When `endCall` is `true`, the assistant should invoke the built-in `endCall` tool after speaking the returned closing reply.

Configure delayed response messages:

- At approximately 1.2 seconds, select one short acknowledgment: “Thanks, I’ve got that.”, “Thanks for letting me know.”, or “Got it—thanks for the details.”
- At approximately 5 seconds: “Thanks for waiting—I’m still with you.”
- At approximately 12 seconds: “This is taking a little longer than expected. I’m still here with you.”

The first message only acknowledges what the caller said, so it remains natural after a name, phone number, service choice, or question. The later messages explain the actual wait.

Publish the tool after changing it.

### Configure the assistant and phone number

Create an assistant named `Maple Street Receptionist`, attach the published tool, and use a prompt that requires every caller turn to go through the tool. The assistant should speak the returned `reply` exactly once and avoid answering business questions from its own model knowledge.

Add Vapi's built-in `endCall` tool. Instruct the assistant to use it only when the backend returns `endCall: true`; it must speak the returned closing reply first. Do not end the call for appointment-time rejection, reset requests, slow responses, or human handoff unless the customer explicitly asks to leave.

Assign the assistant to the Vapi phone number. Set the phone number's server URL to:

```text
https://<your-ngrok-domain>/vapi/events
```

Use the same Bearer credential for this webhook and set a timeout long enough for the backend's controlled provider timeout. Save the phone number configuration.

### Verify the Vapi integration

1. Open the Vapi phone assistant or call the configured number.
2. Ask a fast question, such as the business hours; no delayed message should be needed.
3. Continue with a multi-turn flow, such as pricing followed by booking.
4. Verify Calendar and Sheets after a booking, reschedule, cancellation, or handoff.
5. End the call and verify one Call Log row with the final intents and outcome.
6. Check the application logs for duration and outcome metadata. Logs must not contain credentials, transcripts, or complete provider payloads.

The tunnel, Vapi credentials, phone number, and local environment values are deployment configuration. They must not be committed to the repository.
