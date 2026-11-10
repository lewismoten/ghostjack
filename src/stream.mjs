// Ghost Jack live stream: ffmpeg copies the camera's RTSP feed into fragmented MP4 for one HTTP client.
// Kept apart from server.mjs so a test can run it with a fake camera and a fake ffmpeg.
import { spawn } from 'node:child_process';

export async function streamVideo({
  camera,
  ffmpeg,
  children,
  req,
  res,
  profile,
}) {
  // Listen for the client leaving before any await: `close` fires once, and the camera call below can
  // take seconds (sign-in retry, busy queue).
  let gone = false;
  let p = null;
  const onGone = () => {
    gone = true;
    if (p) p.kill('SIGKILL');
  };
  req.on('close', onGone);
  res.on('close', onGone);
  const url = await camera.streamUrl(profile); // never logged or sent to the client
  if (gone || res.destroyed || res.writableEnded) return;
  // Fragmented MP4: H.264 copied as-is (no re-encode), AAC copied. Low latency (0.1.2): no input
  // buffering, a short probe, and a fragment every 0.5 s (not only at keyframes: the camera sends one
  // about every 4.8 s, which made the picture 5 to 10 s late), each flushed as soon as it is written.
  p = spawn(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-fflags',
      'nobuffer',
      '-flags',
      'low_delay',
      '-probesize',
      '32k',
      '-analyzeduration',
      '0',
      '-rtsp_transport',
      'tcp',
      '-i',
      url,
      '-c',
      'copy',
      '-movflags',
      'frag_keyframe+empty_moov+default_base_moof',
      '-frag_duration',
      '500000',
      '-flush_packets',
      '1',
      '-f',
      'mp4',
      'pipe:1',
    ],
    { stdio: ['ignore', 'pipe', 'ignore'] },
  );
  children.add(p);
  let started = false;
  p.on('error', () => {
    // ffmpeg missing or not runnable: answer instead of crashing the bridge
    children.delete(p);
    if (res.writableEnded || res.destroyed) return;
    if (!started) {
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'ffmpeg could not start' }));
    } else res.end();
  });
  p.on('spawn', () => {
    if (gone || res.headersSent) return;
    started = true;
    res.writeHead(200, {
      'Content-Type': 'video/mp4',
      'Cache-Control': 'no-store',
    });
    p.stdout.pipe(res);
  });
  p.on('exit', () => {
    children.delete(p);
    if (started) res.end();
  });
}
