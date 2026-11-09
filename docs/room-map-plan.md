# Room map: plan

Goal: the control page's 3D view shows the room itself, not just the camera
turning: the monitors, the laptop, the desk, the Pocket Player boards, the TV,
doors and walls, placed roughly where they are, with the camera in the middle
pointing at what it's looking at. Everything runs on the Mac; no picture leaves
home.

The camera has no depth sensor (one fixed lens, no stereo or time-of-flight),
and it rotates around its own center, so it can't judge distance from parallax.
Depth has to come from software, so the map is approximate.

## Steps

1. **A pan/tilt sweep.** Step the camera across its range in small moves (step
   10, speed 100, one per second), taking a snapshot at each position and
   recording the estimated pan and tilt. One sweep gives a rough panorama of the
   room.
2. **Depth per picture.** Run a local monocular depth model on each snapshot:
   Depth Anything V2 Small (Apache 2.0) or MiDaS (MIT), through ONNX Runtime or
   PyTorch on the Mac. That gives relative depth (near versus far) for every
   pixel.
3. **Objects per picture.** Run a local object detector (an open model with a
   permissive license, chosen when building) for people, dogs, chairs, monitors,
   laptops, TVs, keyboards and so on, plus names I add myself for things it
   doesn't know ("Pocket Player board", "the Pi's TV").
4. **Combine into a map.** Turn each picture's pixels into directions using the
   camera's estimated pan and tilt and its field of view, and push each one out
   by its estimated depth. The result is a point cloud around the camera, with
   labeled boxes where objects were found.
5. **Real scale.** Enter one or two known sizes ("the door is 80 inches tall",
   "the desk is 30 inches high") to turn relative depth into rough distances.
6. **Show it.** The three.js view draws the room as a neon point cloud with
   labeled objects, and the camera model in the middle. Clicking an object turns
   the camera toward it, and the AI tools can say "look at the left monitor".
7. **Keep it current.** A **Re-sweep** button on the control page (and a
   `camera_resweep` AI tool) redoes the sweep and updates the map; later, the
   bridge can notice changes (a moved chair, someone walking in) and refresh
   just that area.

## Aiming in 3D: drag the view itself

Once the room map exists, aiming stops being "press left four times" and becomes
"look there":

- **Drag the video to aim.** Dragging the live picture shows a wireframe outline
  (the camera's view frustum) of where it will look next, drawn over the room
  map and over the edges of the current picture, so I can see the new view
  before the camera moves. On release, the camera steps toward it, and the
  outline stays until the estimate arrives.
- **Click a spot or an object** in the map or the picture to center the camera
  on it ("look at the left monitor").
- **The limits** found by "Find limits" bound the outline, so it can't be
  dragged past a wall the camera can't turn through.
- **Before the full map:** the panorama from a single sweep (step 1) is enough
  to show the outline over the stitched room picture, without depth, so this can
  start early.

## Showing new discoveries

Whenever the map learns something new (an unseen part of the room comes into
view, or an object is recognized for the first time), the live picture shows it
happening: the newly mapped region briefly turns into an animated neon wireframe
(edges and depth contours traced over that part of the image, with any new
object's label drawn in), then dissolves back into the normal video. Already
mapped areas stay plain, so the effect marks only what's new. Reduced motion: a
brief outline and label instead of the animation.

## Limits to keep in mind

- Depth from one picture is a good guess at shape and order, not a measurement.
  Expect errors of tens of percent at a distance, and trouble with mirrors,
  screens and glass.
- Pan and tilt positions are estimates (the camera doesn't report them), so the
  map drifts unless the camera is re-centered at a known position before each
  sweep.
- The map and its pictures show the room and whoever is in it, so they stay
  local and out of the repository, like every other capture. Only code and this
  plan are committed.

## Order

After the bridge and the speaker (both exist as of 0.1.0). The first slice is
steps 1, 2 and 6 (sweep, depth and a point cloud in the 3D view); objects, scale
and click-to-look come next.
