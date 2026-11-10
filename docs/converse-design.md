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

## Not done

- **Streaming recognizer.** Partials are the whole utterance transcribed again
  every 1.5 s (whisper is not a streaming model). A true streaming model
  (Sherpa-ONNX Zipformer or Moonshine, both in
  `~/Documents/rivers-of-memory-workspace/models`) needs `onnxruntime` in this
  repository, which is a new dependency, a licence entry in NOTICE.md and a
  decision. `GJ_WHISPER_PARTIAL_MODEL` can name a smaller ggml model for
  partials (`ggml-base.en` is a 140 MB download, MIT) so partials land in under
  a second.
- **One live publish for a whole reply.** Replies are one publish per line.
  Streaming PCM into a single paced publish would remove the gaps and make
  playback position exact (bytes fed against the clock), so barge-in reports
  would stop being estimates. It must be tested against the real camera because
  an unfinished publish jams the speaker, so it was not attempted unattended.
- **Synthesizer word marks.** macOS `say` gives none, so word times are spread
  by letters.
- **Own-voice transcription inside barge-in** (see Echo handling).

## Live tests in the room

Echo and barge-in: speak while a long reply plays; check it stops, the `barge`
event says what was heard, and a quiet reply does not stop itself. Check the
delay with `tools/echo-calibrate.mjs`. Check `fast` lines after the first are
heard from their first word. Wake words with real speech and room noise.
