# Voice relay: plan

Goal: the camera becomes a small voice assistant that relays between an AI
(Claude, or any other model or tool) and me. The AI sends a question or
statement; the camera says it out loud in a chosen voice; I answer out loud; my
answer is transcribed and handed back to whoever asked, by webhook or by
checking in later with a token.

It's a feature of the bridge (`src/server.mjs`), so it uses the same login,
access token and CORS rules, and anything that can call the bridge can use it.
Everything runs on the Mac: speech is generated and transcribed locally, and no
audio leaves home.

## The flow

1. **Ask.** A caller sends `POST /api/voice/ask`:
   ```json
   {
     "text": "The Pi rolled back again. Want me to try the new build?",
     "kind": "question",
     "voice": "doc-leo",
     "from": "claude",
     "reply": {
       "webhook": "http://localhost:9000/voice-reply",
       "timeout_s": 120
     }
   }
   ```
   `kind` is `question` (wait for an answer) or `statement` (just say it). The
   bridge answers right away with a **ticket**:
   `{ "ticket": "vq_7f3k…", "status": "queued" }`.
2. **Chime and wait.** The bridge plays a short chime (each assistant has its
   own) and **waits for me to acknowledge** before saying anything. Acknowledge
   by saying "go ahead" (a short listen window after the chime), pressing a
   button on the control page, or later a gesture the camera can see. "Not now"
   or no acknowledgment within a set time leaves the message waiting
   (`pending`), and it chimes again later or waits until I ask "any messages?".
3. **Speak.** After the acknowledgment, the bridge turns the text into speech in
   that assistant's voice and plays it.
4. **Listen.** For a question, it records from the camera's microphone until I
   stop talking (silence detection), up to the timeout.
5. **Transcribe.** Local Whisper turns my answer into text.
6. **Deliver.** It stores the result under the ticket and, if a webhook was
   given, POSTs it there:
   ```json
   {
     "ticket": "vq_7f3k…",
     "status": "answered",
     "text": "Yes, go ahead.",
     "asked_at": "...",
     "answered_at": "...",
     "confidence": 0.93
   }
   ```
   Any caller can also check later with `GET /api/voice/tickets/vq_7f3k…`, which
   returns `queued`, `chimed`, `pending` (not acknowledged yet), `speaking`,
   `listening`, `answered`, `no_answer` (timed out), `declined` ("not now") or
   `failed`.

## Voices

- **Each assistant has its own voice and chime** (for example Claude, Kaylee and
  Codex each sound different), set in the bridge's settings, so I know who's
  asking before the message plays. A caller can't pick another assistant's
  voice.

- Generated locally with the voice tools I already use for the GameMaker tour
  (Pocket TTS and Kokoro in `.narrate`). A voice list comes from
  `GET /api/voice/voices`.
- My own cloned voice is used only where I say so (for example as Doc Leo); the
  default is a clearly synthetic assistant voice, so nobody mistakes the camera
  for me. Each voice is labeled with whether it's my voice or a model's.
- Messages can say who's speaking ("Claude says…") so I know which assistant is
  asking.

## Several assistants, one camera

- One speaker and one me, so asks wait in a **queue**, one at a time, with a
  `priority` for urgent ones. `GET /api/voice/queue` shows what's waiting; I can
  skip or cancel from the control page.
- Each caller gets its own access token (named: "claude", "kaylee", "codex"), so
  tickets show who asked, and a token can be switched off without affecting the
  others.
- **AI tools:** the MCP server gets `camera_say(text, voice)`,
  `camera_ask(text, voice, timeout)` (returns the ticket),
  `camera_get_reply(ticket)` and `camera_wait_reply(ticket, timeout)`.

## Transcript log (optional, off by default)

- When turned on, each exchange (time, assistant, ticket, what was said, my
  transcribed answer, confidence) is appended to a log, one file per day.
- **Where:** the goal is the camera's microSD card, so the log lives with the
  camera. Whether the camera lets the bridge write its own files there is still
  unknown: its API shows SD status and control (`ccm_disk_get`, `ccm_disk_ctl`),
  but not file uploads. If it doesn't, the log goes to a folder on the Mac
  instead, and the setting says which.
- Text only, never audio. It can be turned off, exported and cleared from the
  control page, and it's never committed to the repository.

## The control page

- A voice panel: the queue, the current message as text (so it's readable too),
  a "repeat" button, buttons to answer by typing instead of speaking, "skip" and
  "not now", and a history of asks and answers.
- A push-to-talk button for starting a conversation myself (later: a wake word).

## Dependencies and order

1. **Output:** the camera's speaker works (`docs/discovery.md` step 13:
   `ccm_talk` plus an RTMP publish), and the bridge already exposes it as
   `POST /api/say` with one talker at a time. The relay reuses that queue; the
   Mac's speakers are only a fallback if the camera is unreachable.
2. **Input:** the camera microphone over RTSP and local Whisper already work
   (step 13).
3. Build order: tickets, queue and webhooks with camera-speaker output
   (`/api/say`, done in 0.1.0) and camera-mic input → the control-page panel
   (the "Glassmouth says" box is its first piece) → MCP tools → per-agent local
   TTS voices.

## Limits and safety

- Transcription can be wrong; answers carry Whisper's confidence, and an
  important "yes" can ask for confirmation.
- Recordings are deleted once transcribed; only the text is kept, locally, and
  never committed.
- The relay only speaks text it's sent and only records after it has asked
  something (or I press talk): no always-on listening without a visible
  indicator on the control page and the camera.
