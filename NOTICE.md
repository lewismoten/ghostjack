# Notices

## three.js

The control page (`web/scene.js`, `web/sphereView.js`) imports three.js 0.170.0,
copied unchanged from the npm package (`build/three.module.js`) into
`web/vendor/three.module.js` (license in `web/vendor/three.LICENSE`), so the
page needs no outside download and works with no internet.

Copyright (c) 2010-2024 three.js authors. MIT License: permission is granted,
free of charge, to use, copy, modify, merge, publish, distribute, sublicense and
sell copies of the software, provided the copyright notice and this permission
notice are included in all copies. The software is provided "as is", without
warranty of any kind. Full text:
https://github.com/mrdoob/three.js/blob/dev/LICENSE

## Playwright

`playwright-core` 1.64.1 (Apache License 2.0, Microsoft) drives the camera's own
web page.

## Sounds

All sound in the control page is generated in the browser with the Web Audio
API. No samples or recordings are used.

## ffmpeg and macOS say

ffmpeg (LGPL/GPL, ffmpeg.org) is run as an external program for the live stream,
digital zoom and speech; it is not included. Speech uses the macOS `say` command
and the voices installed on your Mac; they are not included either.

## Credits for the making

Glassmouth's character sketch came from Lewis Moten's conversation with GPT-6.1
Sol (OpenAI). The code was written with Claude (Anthropic: Opus 5.5 and Sonnet
5.5).
