# Voice relay: plan

Goal: the camera becomes a small voice assistant that relays between an AI (Claude, or any other model or tool) and me. The AI sends a question or statement; the camera says it out loud in a chosen voice; I answer out loud; my answer is transcribed and handed back to whoever asked, by webhook or by checking in later with a token.

It's a feature of the bridge (`src/server.mjs`), so it uses the same login, access token and CORS rules, and anything that can call the bridge can use it. Everything runs on the Mac: speech is generated and transcribed locally, and no audio leaves home.

## The flow

1. **Ask.** A caller sends `POST /api/voice/ask`:
   ```json
   { "text": "The Pi rolled back again. Want me to try the new build?",
     "kind": "question",
     "voice": "doc-leo",
     "from": "claude",
     "reply": { "webhook": "http://localhost:9000/voice-reply", "timeout_s": 120 } }
   ```
   `kind` is `question` (wait for an answer) or `statement` (just say it). The bridge answers right away with a **ticket**: `{ "ticket": "vq_7f3k…", "status": "queued" }`.
2. **Speak.** The bridge turns the text into speech with the chosen voice, plays a short chime, then the message.
3. **Listen.** For a question, it records from the camera's microphone until I stop talking (silence detection), up to the timeout.
4. **Transcribe.** Local Whisper turns my answer into text.
5. **Deliver.** It stores the result under the ticket and, if a webhook was given, POSTs it there:
   ```json
   { "ticket": "vq_7f3k…", "status": "answered", "text": "Yes, go ahead.",
     "asked_at": "...", "answered_at": "...", "confidence": 0.93 }
   ```
   Any caller can also check later with `GET /api/voice/tickets/vq_7f3k…`, which returns `queued`, `speaking`, `listening`, `answered`, `no_answer` (timed out) or `failed`.

## Voices

- Generated locally with the voice tools I already use for the GameMaker tour (Pocket TTS and Kokoro in `.narrate`). A voice list comes from `GET /api/voice/voices`.
- My own cloned voice is used only where I say so (for example as Doc Leo); the default is a clearly synthetic assistant voice, so nobody mistakes the camera for me. Each voice is labeled with whether it's my voice or a model's.
- Messages can say who's speaking ("Claude says…") so I know which assistant is asking.

## Several assistants, one camera

- One speaker and one me, so asks wait in a **queue**, one at a time, with a `priority` for urgent ones. `GET /api/voice/queue` shows what's waiting; I can skip or cancel from the control page.
- Each caller gets its own access token (named: "claude", "kaylee", "codex"), so tickets show who asked, and a token can be switched off without affecting the others.
- **AI tools:** the MCP server gets `camera_say(text, voice)`, `camera_ask(text, voice, timeout)` (returns the ticket), `camera_get_reply(ticket)` and `camera_wait_reply(ticket, timeout)`.

## The control page

- A voice panel: the queue, the current message as text (so it's readable too), a "repeat" button, buttons to answer by typing instead of speaking, "skip" and "not now", and a history of asks and answers.
- A push-to-talk button for starting a conversation myself (later: a wake word).

## Dependencies and order

1. **Output:** until the camera's speaker works (the RTDP talk channel in `docs/discovery.md` step 13), speech plays through the **Mac's speakers** instead. Everything else works now.
2. **Input:** the camera microphone over RTSP and local Whisper already work (step 13).
3. Build order: tickets, queue and webhooks with Mac-speaker output and camera-mic input → the control-page panel → MCP tools → switch output to the camera speaker once talking works.

## Limits and safety

- Transcription can be wrong; answers carry Whisper's confidence, and an important "yes" can ask for confirmation.
- Recordings are deleted once transcribed; only the text is kept, locally, and never committed.
- The relay only speaks text it's sent and only records after it has asked something (or I press talk): no always-on listening without a visible indicator on the control page and the camera.
