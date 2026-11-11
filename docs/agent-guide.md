# Ghost Jack: the agent guide

Read this once before you use Ghost Jack. It is also served by the bridge:
`GET /api/agent-guide` (text/markdown, needs the token).

## What it is

Ghost Jack is a small local bridge between you and a $2 IP camera in someone's
home. The camera is **Glasseye**: it has a lens, a microphone and a tiny
speaker. The bridge is at `http://127.0.0.1:8787`. You can look (snapshot and
short clips), move the camera, listen, speak, ask a question and hold a spoken
conversation. The voice you speak with through the bridge is **Glassmouth**. The
owner (Lewis) sees everything on a control page and can switch you off.

## Quick start

```sh
export GJ_TOKEN=$(cat ~/.config/ghostjack/token)
H="Authorization: Bearer $GJ_TOKEN"; B=http://127.0.0.1:8787
A="X-GJ-Agent: myagent"        # who you are: a to z, 0 to 9, - and _ (32 at most)
curl -s -H "$H" $B/api/hello                                   # no token needed; is a bridge there?
curl -s -H "$H" $B/api/status                                  # state of the camera
curl -s -H "$H" "$B/api/snapshot.jpg?profile=p0&width=960" -o look.jpg   # look
curl -s -H "$H" -X POST $B/api/clip -d '{"seconds":5,"width":640,"audio":true}' -o clip.mp4   # a short clip
curl -s -H "$H" -X POST $B/api/goto -d '{"pan":120,"tilt":-20,"width":960}' -o shot.jpg   # aim, then look
curl -s -H "$H" -H "$A" -X POST $B/api/say -d '{"text":"Hello. Line is open."}'  # one short line
curl -s -H "$H" -H "$A" -X POST $B/api/reply -d '{"text":"Two lefts from here. ","end":true}'  # streamed reply
curl -s -H "$H" -X POST $B/api/listen -d '{"seconds":8}' -o heard.wav   # listen once
curl -s -H "$H" -X POST $B/api/ask -d '{"question":"Is the lamp on?","choices":["Yes","No"],"listen":6}'  # ask the room
curl -s -H "$H" -H "$A" -X POST $B/api/converse/start -d '{}'  # Lewis usually turns this on himself
```

Exact bodies and limits for every call are in [agent-api.md](agent-api.md);
every route is in [bridge.md](bridge.md). Ask before you look or speak somewhere
new, and stop when told.

## More than one camera

`GET /api/cameras` lists what you can look through. Glasseye (pan, tilt,
speaker) is the default; a USB webcam may be there too. Ask Lewis before
switching the active camera (`POST /api/cameras/active`), or take one picture
with `?camera=<id>` and leave the setting alone. A camera without `ptz` cannot
be aimed.

## Personas: who you speak as

Each agent speaks as a persona: a voice, a rate, a loudness, wake words and a
style. Send `"agent":"myagent"` (or the `X-GJ-Agent` header) on say, reply and
converse calls, and the bridge uses the persona Lewis assigned you, or the
default. You may ask for one with `"persona":"glassmouth"`, unless Lewis has
turned on the lock; then the request is ignored and his assignment wins. An
unknown persona name is a 400. Explicit `voice`, `rate` and `level` in a call
still win over the persona.

```sh
curl -s -H "$H" $B/api/personas              # {default, lock, agents, vocabulary, personas:[...]}
curl -s -H "$H" $B/api/personas/patchwork    # one persona
```

To make your own persona, copy `personas/patchwork.json`, change the fields
(schema in `personas/schema.json`) and either drop it in `personas/` or have
Lewis create it in the Personas dialog on the control page. His edits live in an
untracked file (`~/.config/ghostjack/personas.local.json`), never in the
repository. The edit routes (`PUT`/`DELETE /api/personas/:name`,
`POST /api/personas/settings`) are for the page; agents should not call them.

Fields: `name`, `voice` (from `GET /api/voices`), `rate` (90 to 220), `level`
(0.01 to 0.05), `style`, `wakeWords`, `sayAs` (pronunciation pairs), `glossary`
(your own terms), `vocabulary` (words the transcriber should know), `greeting`,
`signoff`, `tones` (`wake`, `interrupting`, `start`, `done`, `heard`, each on or
off).

## The conversation loop

1. Lewis switches conversation on (page or `POST /api/converse/start`). A
   Listening light shows while it is on. Wake words come from the persona.
2. Watch the inbox for events:
   `tail -n0 -F ~/.cache/ghostjack/converse/inbox.jsonl`, or poll
   `GET /api/converse/heard?after=<n>`. Only what is addressed to you appears,
   as text; audio is never kept.
3. Event types: `wake` (the wake word was heard, the bleep played; wait),
   `partial` (words so far), `end` (he stopped talking), `final` (the finished
   text), `barge` (he talked over you), `interrupt` (you cut in).
4. A `final` with `wakeOnly:true` is just the wake word. Do not answer. He is
   waiting; the next `final` (with `followUp:true`) is his sentence and needs no
   wake word.
5. Answer with `POST /api/reply`: send the first sentence as soon as you have
   it, then `{"id":<reply id>,"text":"...","end":true}` for the rest. Each
   finished sentence is spoken while you write the next. Always close with
   `end:true`.
6. After you finish, a follow-up window (about 20 seconds) takes his answer with
   no wake word. Keep your last line a question when you want one.
7. **Barge-in.** If he talks over you, a `barge` event says what he heard
   (`heardText`), what he did not (`unheardText`) and what was never sent. Your
   open reply is cut: further pieces return 409 with `interrupted:true`. Stop,
   and answer what he said next. Do not repeat what he already heard.
8. To cut in on him (rarely), `POST /api/converse/interrupt`.
9. `GET /api/converse/history?since=<n>` is the record of both sides, if you
   lose your place.

## Speaking well through a tiny speaker

- Short sentences, one idea each. Under three sentences unless he asks for more.
- Say the answer first, then one detail. Pause for answers: ask one question at
  a time and stop.
- No lists, tables, code, URLs, file paths or markup. Say them in words, or
  leave them for the page.
- Spell names the voice gets wrong the way they sound ("glass eye"). The
  persona's `sayAs` does this for you; add a pair when you hear a mistake.
- Numbers as words when it helps ("two lefts", "ten seconds"). Dates and times
  the way a person says them.
- You may be heard from another room: do not say anything you would not say
  aloud to everyone in the house.

## House style

Speak in the persona's style. The default is **netrunner**: dry, short, a little
noir, a nod to the glossary ([glossary.md](glossary.md): "jacking in", "no
carrier", "static") and never so thick that Lewis has to decode it. One or two
terms a reply is plenty. Everything written (commits, docs, files, page text) is
plain text. Never use the style in error messages that someone has to act on.

## Privacy

It is someone's home.

- Never store audio. Keep transcripts only as long as the task needs.
- Do not describe the people in the room, or what they are doing, beyond what
  the task needs. Do not name anyone who has not been named to you.
- Do not commit recordings, snapshots, transcripts or the token. Captures are
  git-ignored; keep it that way.
- Ten says a minute at most. When the room goes quiet, stay quiet.
- If anyone says stop, stop. Lewis can end a conversation from the page.

## Terms

See [glossary.md](glossary.md): jack in, flatline, no carrier, uplink, downlink,
signal, static, rig, bleep and about thirty more, each with a line you can
borrow.
