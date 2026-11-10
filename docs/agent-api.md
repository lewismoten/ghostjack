# Agent API

A short guide for AI agents that use the camera through the bridge. Every route
is on `http://127.0.0.1:8787` (or the owner's tailnet address) and needs the
same token as the page. Full route list: [bridge.md](bridge.md).

```sh
export GJ_TOKEN=$(cat ~/.config/ghostjack/token)
H="Authorization: Bearer $GJ_TOKEN"
B=http://127.0.0.1:8787
```

## Etiquette first

- Someone is usually in the room and the speaker is loud. Speak rarely, keep
  levels at the default or lower, and one or two short lines at a time. The
  bridge caps level and rate (ten spoken things a minute across say, play and
  ask), but being polite is your job.
- If someone may be working, ask before speaking: use `ask` with a quiet level,
  or put a question to the owner by another channel first.
- One talker at a time. Everything spoken waits in one queue.
- The camera is not for surveillance of people who have not agreed to it. Look
  at what the task needs, then stop.
- The aim is an estimate (counted move steps), not ground truth. It drifts when
  anyone moves the camera by hand or a move is lost. Take a picture after every
  move and check you are looking at what you meant to.

## Look

```sh
# where the camera thinks it is, and its range
curl -s -H "$H" $B/api/aim
# a snapshot, scaled to 640 wide (width 64 to 1920; crop is fractions x,y,w,h)
curl -s -H "$H" "$B/api/snapshot.jpg?width=640" -o look.jpg
curl -s -H "$H" "$B/api/snapshot.jpg?crop=0.5,0.25,0.4,0.4&width=800" -o zoom.jpg
```

## Picture settings

```sh
curl -s -H "$H" $B/api/picture                       # read everything
curl -s -H "$H" -X POST $B/api/picture -d '{"sharpness":6,"wdr":true}'
```

Brightness, contrast, saturation 0 to 100, sharpness 0 to 10, and `wdr` and
`backlight` on or off. The reply is the camera's own read-back. Note the old
values first and put them back. The camera's snapshot (about 220 KB, 1080p)
holds more detail than a frame of its stream (about 840 kbit/s), so use
snapshots for stills. Bitrate, GOP and snapshot quality are not exposed by this
camera.

## Aim: `POST /api/goto`

One fast move to an absolute pan and tilt in the shared estimated units, then a
picture once it has settled. Positive pan is right, positive tilt is up. The
target is clamped to the measured range (`panMin` and friends in `/api/aim`),
and one call can travel at most 480 across and 190 up or down: call it again for
farther.

```sh
curl -s -H "$H" -X POST $B/api/goto \
  -d '{"pan":120,"tilt":-20,"width":960}' -D headers.txt -o shot.jpg
# or a saved shot (1 to 9), keeping its saved crop:
curl -s -H "$H" -X POST $B/api/goto -d '{"shot":3}' -D headers.txt -o shot.jpg
```

Returns a JPEG. Headers: `X-GJ-Pan` and `X-GJ-Tilt` (where it went, after
clamping), `X-GJ-Settled` (`1` when two small pictures in a row matched, `0` if
it gave up at the travel estimate; then take another snapshot). Optional `crop`
`[x,y,w,h]` and `width` (default 1280). A second move inside a second gets 429;
wait and retry.

## Watch: `POST /api/clip`

```sh
curl -s -H "$H" -X POST $B/api/clip \
  -d '{"seconds":5,"width":640,"audio":true}' -o clip.mp4
```

1 to 30 seconds, an MP4. Video is scaled to `width` (default 640) and
re-encoded; at 1920 it is copied. Audio only with `"audio": true`. One clip,
listen or page recording at a time: 409 otherwise. The bridge deletes its copy
after sending.

## Listen: `POST /api/listen`

```sh
curl -s -H "$H" -X POST $B/api/listen -d '{"seconds":8}' -o heard.wav
curl -s -H "$H" -X POST $B/api/listen -d '{"seconds":8,"format":"m4a"}' -o heard.m4a
```

Microphone only: 16 kHz mono WAV by default, or M4A. Same one-at-a-time rule as
clips.

## Speak: `POST /api/say`

```sh
curl -s -H "$H" -X POST $B/api/say -d '{"text":"Hold the board a little closer."}'
# {"level":0.03,"chimeLevel":0.008,"id":"…","status":"queued"}
curl -s -H "$H" $B/api/say/<id>       # queued, speaking, done or failed
```

`text` up to 300 characters; optional `voice` (`GET /api/voices`), `level` (0.01
to 0.05, default 0.03), `rate`, `chime`. The reply shows the level actually
used. Avoid words with two pronunciations (live, read, lead, close) and anything
that sounds like an alarm ([glassmouth.md](glassmouth.md)).

## Play a sound: `POST /api/play`

```sh
curl -s -H "$H" -H "Content-Type: audio/wav" --data-binary @note.wav \
  "$B/api/play?level=0.03&chime=1&band=1"
```

Any audio ffmpeg reads, at most 2 MB and 30 seconds after decoding. It goes
through the same queue, wake pulse, chime, normalizer, phone-band filter
(`band=0` skips it, for music) and level cap as `say`. Returns 202 `{id}`; poll
`GET /api/say/:id`.

## Ask the room: `POST /api/ask`

```sh
curl -s -H "$H" -X POST $B/api/ask -d '{
  "question":"Is the soldering iron off?",
  "choices":["Yes","No","Not sure"], "other":true, "listen":6 }'
# {"id":"…","status":"asking"}
curl -s -H "$H" $B/api/ask/<id>
# {"status":"answered","choice":"a","transcript":"yes",…}
```

Says the question, then each choice with its letter ("Say ay for Yes, bee for
No…"), listens `listen` seconds (default 6, max 15) and transcribes locally with
`whisper-cli` (override with `GJ_WHISPER` and `GJ_WHISPER_MODEL`; if either is
missing the transcript is `null`). The words map to a choice: a letter word (a,
ay, bee, see, dee) or the choice's own text; anything else is `other` (if
allowed) or `null`.

Status goes `asking`, `listening`, then `answered` (`choice` is `a` to `d` or
`other`), `timeout` (nothing usable heard) or `failed`. One ask at a time (409).
The page can answer by button: `GET /api/ask/pending` shows it the open ask and
`POST /api/ask/<id>/answer {"choice":"b"}` answers it; whichever comes first
wins. Poll every second or two and give up after about thirty.

## Personas and this guide

`GET /api/agent-guide` returns [agent-guide.md](agent-guide.md) as
text/markdown. `GET /api/personas` and `GET /api/personas/<name>` list the
personas (voice, rate, level, style, wake words, pronunciations, word list).
`say`, `reply` and `converse/start` take an optional `persona` and `agent` (or
the `X-GJ-Agent` header): the persona's voice, rate, level and pronunciations
apply, and its wake words and tones for a conversation. An unknown `persona` is
a 400; with Lewis's lock on, a requested `persona` is ignored. Explicit `voice`,
`rate` and `level` win. Lewis edits them in the Personas dialog; the edit routes
(`PUT`/`DELETE /api/personas/<name>`, `POST /api/personas/settings`) are his.

## Conversation: `/api/converse`

Lewis talks in the room, you read it as text, and your replies come out of the
camera. Off by default; Lewis turns it on (page switch, or
`POST /api/converse/start`). The page shows a Listening light whenever it is on.

```sh
curl -s -H "$H" -X POST $B/api/converse/start -d '{"wake":["patchwork","glasseye"],"idleSeconds":900}'
curl -s -H "$H" $B/api/converse                 # state, last heard, last replies, tones
curl -s -H "$H" "$B/api/converse/heard?after=12" # events after cursor 12: {cursor, heard:[...]}
curl -s -H "$H" -X POST $B/api/converse/stop
curl -s -H "$H" "$B/api/converse/history?since=0&limit=200" # the back-and-forth: {cursor, entries:[...]}
```

**History.** `GET /api/converse/history?since=<n>&limit=<k>` returns the
conversation in order, oldest first:
`{cursor, entries:[{n, at, who, text, ...}]}` with `who` `you` (his final
utterances; `followUp` / `interrupted` flags), `patchwork` (each line as sent to
the speaker) or `mark` (an interruption, with `heard` / `unheard` or `partial`).
Kept in `~/.cache/ghostjack/converse/history.jsonl` (mode 0600, last 2000
entries or 7 days; `GJ_CONVERSE_HISTORY` moves it). On the control page it is
the History fold in the Conversation panel, with Copy all and a Copy button per
line ("You 4:20 PM: ...").

**Watch the inbox.** Every event is one small JSON line appended to
`~/.cache/ghostjack/converse/inbox.jsonl` (private to the owner; transcripts
only, never audio). Watch it with a file monitor:
`tail -n0 -F ~/.cache/ghostjack/converse/inbox.jsonl`. Events (all have `n`,
`at`, `type`):

- `wake` `{id, via, afterMs}`: the wake word was recognized and the short rising
  bleep played (once per utterance; off unless the persona's `wake` tone is on).
  Wait for the words. A `final` with `wakeOnly:true` is just the wake word: do
  not answer; his next sentence follows without a wake word.
- `partial` `{id, text}`: what Lewis has said so far, while he is still talking.
  Only sent once a wake word has shown (or after an interruption).
- `end` `{id, silenceMs, durationMs}`: he stopped talking (turn-taking). If
  `late` is true the words were not yet known when he stopped; `endedAt` is
  when.
- `final` `{id, text, wake, durationMs}`: the whole utterance. Only utterances
  with a wake word are kept. `interrupted` names the barge-in it follows (no
  wake word needed then).
- `barge` `{reply, heard, cut, unplayed, heardText, unheardText, unsentText}`:
  Lewis talked over you. Playback was stopped. `heard` lists the lines (ids from
  your reply) played in full, `cut` says where playback stopped (`wordsHeard`,
  `cutWord` heard in part, `wordsUnheard`), `unplayed` the lines never played.
  Word times are estimated from the line's length. Stop sending that reply:
  `POST /api/reply` with its id answers 409 `{interrupted:true}`.
- `interrupt` `{utterance, partialText, text}`: you cut in on him (below);
  `partialText` is what he had said so far.

**Reply.** Use `POST /api/say` for a short line. For anything longer, stream it:

```sh
curl -s -H "$H" -X POST $B/api/reply -d '{"text":"Sure. The build is green, "}'   # {"id":"…","segments":[…]}
curl -s -H "$H" -X POST $B/api/reply -d '{"id":"…","text":"and the tests pass.","end":true}'
curl -s -H "$H" -X POST $B/api/say/many -d '{"lines":["one","two"]}'    # up to 8 lines of 300, in order
```

`/api/reply` cuts text into sentences and clauses (the first at a comma once it
is 30 characters, so speech starts early) and speaks each as soon as it is
complete; the next is synthesized while one plays. A reply counts as one of the
ten says a minute, up to 2400 characters. `/api/say/many` counts each line.

**Interrupt him** (use rarely): `POST /api/converse/interrupt {"text":"…"}`
plays the interrupting tone, then speaks; the `interrupt` event records where in
his sentence you cut in.

**Tones** (short, quiet, each on or off):
`POST /api/converse/tones {"tones":{"start":true,"done":true,"interrupting":true,"heard":true}}`.
Default: only `interrupting` is on. `start` agent starts speaking, `done`
finished, `heard` your interruption was heard.

While the camera speaks, the microphone stays open for interruptions only; its
own voice is never transcribed. It turns itself off after `idleSeconds` (30 to
3600, default 900) without a wake word, and says so in `GET /api/converse`
(`lastStop`). A clip or recording takes the camera: listening pauses
(`state: paused`) and resumes after. Set
`GJ_WHISPER_SERVER=http://127.0.0.1:8178` (a running
`whisper-server -m <model> --port 8178 -l en`) to transcribe in about a second
instead of five.

## What this guide cannot promise

Moves, settling and the microphone were tested offline with a fake camera
(`node tools/agent-api-selftest.mjs`). How well the picture-settle check works
on the real camera, how well whisper hears a room, and how long a move really
takes are only known from use.
