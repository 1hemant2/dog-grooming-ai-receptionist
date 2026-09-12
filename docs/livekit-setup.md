# LiveKit browser voice setup

This setup adds a local browser voice demo without replacing the existing text or Vapi paths. LiveKit transports microphone and speaker audio, LiveKit Inference provides speech recognition and speech synthesis, and the existing application remains responsible for conversation state, business rules, Calendar, Sheets, Telegram, and Call Log persistence.

## Configure LiveKit Cloud

Create a LiveKit Cloud project and copy its URL, API key, and API secret into the local `.env` file:

```text
LIVEKIT_URL=wss://<project>.livekit.cloud
LIVEKIT_API_KEY=<project-api-key>
LIVEKIT_API_SECRET=<project-api-secret>
LIVEKIT_AGENT_NAME=maple-street-receptionist
```

The backend owns the voice room connection and its conversation handler in the same Node process. No separate agent worker, internal HTTP token, or Redis service is needed. Old `LIVEKIT_BACKEND_URL` and `LIVEKIT_BACKEND_TOKEN` entries can be removed from existing environment files.

The voice session uses LiveKit Inference with:

- STT: `deepgram/nova-3` with `en-IN` language guidance for Indian English.
- TTS: `inworld/inworld-tts-2` with the `Ashley` voice.
- Turn detection: STT end-of-utterance events. Completed turns are delivered to `BackendVoiceAgent.onUserTurnCompleted`, which calls the local conversation handler.
- Interruptions are disabled for the demo; wait until the receptionist finishes speaking before answering.

These model requests go through LiveKit Inference, so no separate Deepgram or Inworld key is needed in this application. Check the current LiveKit Cloud plan before a longer demo.

## Run the demo

Start the application in one terminal:

```bash
npm run dev
```

Open `http://localhost:3000`, click **Start voice**, allow microphone access, and speak. The browser requests `/livekit/token`. The backend joins the room directly as the voice participant before returning the customer's room token. It uses LiveKit's `Room` and `AgentSession` primitives without `AgentServer`, worker registration, agent dispatch, or job subprocesses.

Each completed customer utterance calls `LiveKitConversationAdapter.handleTurn()` directly. The same conversation store and orchestrator handle chat and voice. The reply is synthesized and played back in the browser. Click **Stop voice** or **End conversation** to finalize the conversation and write one Call Log entry. Application shutdown closes the active voice sessions and finalizes their conversations.

Stop any old `npm run livekit:agent` terminal before using this version. The worker scripts and `/livekit/conversations/messages` and `/livekit/events` routes are no longer part of this integration.

## Public deployment note

The backend needs outbound access to LiveKit Cloud and LiveKit Inference. Browser microphone capture requires localhost or HTTPS. API credentials remain on the server; the browser receives only its room-scoped participant token. Conversation state remains process-local and is lost on restart, as in the text demo.

The application serves the browser SDK locally at `/vendor/livekit`, so the demo does not depend on a third-party CDN at runtime.
