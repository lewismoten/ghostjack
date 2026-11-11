# Conversation: design, numbers and what is not done

## Measured (fake camera, this Mac, whisper large-v3, synthetic speech from `say`)

| Stage                                                              | Time                                                                                                               |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| One transcription of a 2.4 s clip, `whisper-cli` (loads the model) | 4 to 5 s                                                                                                           |
| The same through a loopback `whisper-server`                       | 1.2 s                                                                                                              |
| Speech start to first partial transcript                           | about 1.5 s (first partial waits for 1 s of audio, then every 1.5 s) plus a transcription: about 2.7 s with server |
| Last word to `final` event                                         | 0.9 s of quiet to end the utterance, plus a transcription: about 2.3 s with server, 6 s with the CLI               |
| Agent text to its first line synthesized and mixed                 | 1.7 s (`say` plus mix); the sound is later by the camera's lead-in, below                                          |
| Three lines, all synthesized                                       | 3.4 s in all; the next is made while one plays                                                                     |

Not measured, because they need the camera and Lewis in the room (the speaker is
loud and one wrong publish can jam it, so none of this was run on the real
camera): the camera's playback delay, the microphone stream's lag, the echo
ratio, barge-in to silence, agent text to first sound.

## What is known from the code

- A normal line sends 1 s of silence, a 0.13 s wake pulse and 0.5 s of quiet
  before the words (the camera's amp wakes on sound), and 1.5 s of tail after.
  So agent text to first sound is at least 1.7 s of lead-in plus synthesis
  (about 1.7 s the first time) plus the camera's own delay: expect about 3.5 s
  or more. Lines after the first in a reply, and tones sent within 10 s of the
  speaker being used, are sent `fast` (0.1 s lead, 0.4 s tail, no wake pulse).
  Whether the amp stays awake that long is untested. Every line is its own
  publish, so expect a gap between lines of the talk-address round trip.
- Barge-in to silence = detection + stop. The echo gate needs 200 ms over its
  threshold; the microphone stream is delayed by an unknown amount (RTSP
  buffering; `GJ_ECHO_DELAY_MS`, default 1200 as a guess), and killing the
  publish does not empty what the camera already buffered: the bridge sends
  audio a little faster than real time ("ahead" pace), so some audio may still
  play after the stop. Measure it.

## Echo handling

The microphone hears the speaker. The gate (`EchoGate` in
`src/converse-turns.mjs`) predicts the echo as k x the loudness of what is
playing (the mixed file's 20 ms envelope, shifted by `GJ_ECHO_DELAY_MS`, the
loudest of +-150 ms), learns k in the first 20 loud frames of a session, then
follows it slowly (never more than 1.3 times the learned value, so a voice is
not learned as echo), and calls it a barge-in when the microphone is more than
1.6 x prediction + a floor for 200 ms. Synthetic tests: echo alone at gains 0.1
to 0.8 never triggers; a steady voice over it triggers within 300 ms; a voice in
a pause of the reply triggers. Other options, not built: cross-correlation
(`estimateLag` is the first half), a real echo canceller (speexdsp or WebRTC AEC
as a native or WASM module) which would also let Lewis's words be transcribed
cleanly while the camera speaks. Until then the words he says during a barge-in
include the tail of the camera's own voice.

`node tools/echo-calibrate.mjs` (needs the bridge and the camera, one short
burst, Lewis present) plays three tone bursts and records them, then prints the
delay and echo ratio to put in `GJ_ECHO_DELAY_MS`.

### The page's own voice

Glassmouth's lines (`web/glass.js`, spoken by the browser through the Mac
speaker) reach the microphone too. The page reports each line's start and end
with `POST /api/converse/page-voice {speaking, text}` (authenticated; end also
fires on a timeout if the browser never says). `src/page-voice.mjs` keeps those
windows. A final whose audio is inside a window plus a tail (`GJ_PAGE_TAIL_MS`,
1.5 s) is dropped (`inside page voice` in the log); one that overlaps only a
start or an end has those words trimmed (`trim`, by word times spread over the
audio). A text safety net removes a line the page spoke in the last 8 s from
either end of a transcript, and drops it if nothing is left. The lines live in
`web/lines.js` so both sides read the same data.

## Not done

- **Streaming recognizer.** Partials are the whole utterance transcribed again
  every 1.5 s (whisper is not a streaming model). A true streaming model
  (Sherpa-ONNX Zipformer or Moonshine, both in
  `~/Documents/rivers-of-memory-workspace/models`) needs `onnxruntime` in this
  repository, which is a new dependency, a licence entry in NOTICE.md and a
  decision. `GJ_WHISPER_PARTIAL_MODEL` can name a smaller ggml model for
  partials (`ggml-base.en` is a 140 MB download, MIT) so partials land in under
  a second.
- **One live publish for a whole reply (built 2026-11-10, needs a live test).**
  A reply is one talk session and one publish (`src/speech-stream.mjs`): a wake
  pulse and lead once, then each sentence's PCM as soon as it is synthesized, a
  350 ms pause between sentences, quiet filler when the next one is late, and a
  tail. The stream feeds PCM to ffmpeg's stdin against its own clock, so each
  sentence's start is an exact byte offset; `publishAt` and the loudness
  envelope per sentence come from that. The bridge log gets one `[say] {...}`
  line per event: `talk` (request latency), `stream-open`, `first-byte`
  (publishAt, setupMs), one `sentence` each (offsetMs, leadMs, speechMs) and
  `stream-end`. Settings (environment): `GJ_STREAM_AHEAD_MS` (1500),
  `GJ_STREAM_PAUSE_MS` (350), `GJ_STREAM_TAIL_MS` (1200), `GJ_STREAM_IDLE_MS`
  (8000: a reply nobody closed ends itself), `GJ_STREAM_KEEPALIVE=silence|tone`
  (default silence; `tone` is a barely audible 1 kHz between sentences, in case
  silence lets the amp sleep), `GJ_PREP_PARALLEL` (2 sentences prepared at
  once). A cut kills ffmpeg and sends the short silent publish, as before.
- **Synthesizer word marks.** macOS `say` gives none, so word times are spread
  by letters.
- **Own-voice transcription inside barge-in** (see Echo handling).

## Live tests in the room

Echo and barge-in: speak while a long reply plays; check it stops, the `barge`
event says what was heard, and a quiet reply does not stop itself. Check the
delay with `tools/echo-calibrate.mjs`. Check `fast` lines after the first are
heard from their first word. Wake words with real speech and room noise.
