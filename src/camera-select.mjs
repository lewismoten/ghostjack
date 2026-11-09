// The one place that picks the camera module. Production always loads camera.mjs;
// GJ_FAKE_CAMERA=<path to a module with the same exports> is a test hook for
// tools/agent-api-selftest.mjs, so the API can be exercised without a camera.
const file = process.env.GJ_FAKE_CAMERA;
export const camera = file ? await import(file) : await import('./camera.mjs');
