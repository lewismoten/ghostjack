# Ghost Jack bench stands

A laser-cut, glue-free kit of angled cradles and a stepped shelf. Small boards
stand up in them so the Ghost Jack camera, sitting on a tripod close to the desk
and looking down and forward, can see their screens. Cut on a Glowforge from 3
mm plywood. Joints are press-fit tabs and slots; the load-bearing kickstand
joints add a wedge key. No glue, no hinges, no screws.

Three cradles (each can also stand alone on its own foot):

- Raspberry Pi Zero W with a 2.13 inch e-Paper HAT
- CYD 2.8 inch (ESP32-2432S028)
- CYD 3.5 inch (ESP32-3248S035)

Nothing here has been cut or tried with real boards yet. Every device number is
a typical published value: **measure and confirm** each one (table below) before
cutting the cradles.

## Build the files

```sh
node hardware/bench-stands/build.mjs                 # writes hardware/bench-stands/out/
node hardware/bench-stands/build.mjs --thickness 3.1 --fitOffset 0.1
node hardware/bench-stands/build.mjs --pi.length 66 --cyd28.stack 12
node hardware/bench-stands/build.mjs --angles 20,35,50 --no-png --out /some/folder
```

No new dependencies. PNG previews are drawn with the repo's `playwright-core`
and its bundled Chromium (`--no-png` skips them). The script checks its own work
and stops with a list when something fails: no two parts closer than 3 mm,
nothing outside the bed margins, every hole at least 2 mm from every other cut,
every label clear of every cut, and every slot exactly
`thickness + fitOffset - kerf` wide (the coupon's slots use their own offsets).
It also checks that the ledge clears the stop bar at every angle. It prints the
part count per sheet.

Settings (`--name value`; device settings are `--pi.length`, `--cyd28.stack` and
so on; the rest are in `params.mjs`): `thickness` 3.0, `kerf` 0.15, `fitOffset`
0, `tabWidth` 12, `boardClear` 0.6, `ledgeHeight` 10, `strutLength` 40,
`strutWidth` 14, `strutTabWidth` 8, `keyHole` 6, `angles` 15,30,45,60,
`stepHeight` 40, `shelfBase` 28, `shelfGap` 6, `stopHeight` 9. Notch positions
(the Pi's ledge notch, the CYDs' rail notch) are in `params.mjs` under each
device.

## Measure and confirm

All millimeters. Measure with calipers, on your own boards and plywood, and
rebuild if a number differs.

| What                                 | Default | Where to measure                                                             |
| ------------------------------------ | ------- | ---------------------------------------------------------------------------- |
| Plywood thickness (`thickness`)      | 3.0     | Caliper across a sheet's edge, in several places; Glowforge 1/8" is 3.0-3.2  |
| Laser kerf (`kerf`)                  | 0.15    | Cut a 20 mm square, measure it, (20 minus measured) is the kerf              |
| Joint looseness (`fitOffset`)        | 0       | Pick from the test coupon (below), never guess                               |
| Pi Zero long edge (`pi.length`)      | 65      | The board's long side; the HAT should match it                               |
| Pi Zero short edge (`pi.width`)      | 30      | The board's short side                                                       |
| Pi Zero stack (`pi.stack`)           | 15      | Back of the Pi (including header pins that stick out) to the top of the HAT  |
| Pi USB ports along the long edge     | 36-62   | From the left end to each side of the micro USB data and power ports (notch) |
| CYD 2.8 long edge (`cyd28.length`)   | 86      | The board's long side                                                        |
| CYD 2.8 short edge (`cyd28.width`)   | 50      | The board's short side                                                       |
| CYD 2.8 stack (`cyd28.stack`)        | 10      | Highest part on the back (or pins) to the glass                              |
| CYD 2.8 USB center up the short edge | 25      | From the bottom edge to the middle of the USB port; notch is 14 wide         |
| CYD 3.5 long edge (`cyd35.length`)   | 98      | The board's long side                                                        |
| CYD 3.5 short edge (`cyd35.width`)   | 55      | The board's short side                                                       |
| CYD 3.5 stack (`cyd35.stack`)        | 11      | Highest part on the back (or pins) to the glass                              |
| CYD 3.5 USB center up the short edge | 27      | From the bottom edge to the middle of the USB port; notch is 14 wide         |
| Cable plug size                      | 14 wide | Widest plug you will use on the CYDs (the rail notch, `railNotch.width`)     |
| Board slack per side (`boardClear`)  | 0.6     | Fit a board between two cut rails; widen if it binds                         |
| Angles (`angles`)                    | 15-60   | Degrees from vertical; try them with the camera at its working height        |

The CYD boards have parts on the back, so each one stands on its ledge with the
back parts toward the plate; the ledge and rails are one `stack + 1` deep.

## Fit test coupon (cut this first)

Sheet `01-coupon-1.svg`: a bar with four slots and four matching tab cards. The
slots are `thickness + offset - kerf` wide with offsets -0.1, 0, +0.1 and +0.2
mm, each engraved with its offset. Push the cards' edges into the slots. Choose
the one that goes in with firm thumb pressure and does not fall out when you
shake it. That offset is your `fitOffset`:

```sh
node hardware/bench-stands/build.mjs --fitOffset 0.1
```

(Plywood swells and varies sheet to sheet; recheck on a new sheet.)

## Sheets

One SVG per sheet, 495 x 279 mm bed with 10 mm margins. Cut = red hairline
(`#FF0000`, no fill). Engrave = blue fill (`#0000FF`, no stroke). No score
lines. The engraved text is made of small filled rectangles (no font needed).

| File                        | What it holds                                                                  |
| --------------------------- | ------------------------------------------------------------------------------ |
| `01-coupon-1.svg`           | Fit bar and four fit cards                                                     |
| `02-pi-1.svg`               | Pi cradle: plate, ledge, two rails, two struts, three keys, foot and stop bar  |
| `03-cyd28-1.svg`            | The same for the CYD 2.8, one rail has the USB notch                           |
| `04-cyd35-1.svg`            | The same for the CYD 3.5                                                       |
| `05-shelf-1.svg`            | The shelf's low and high treads                                                |
| `06-shelf-2.svg`            | Shelf sides, tie bar and two stop bars                                         |
| `assembly.svg` (and `.png`) | Side views at every angle and an exploded view (a drawing, not a cutting file) |

PNG previews sit beside each SVG in `out/`.

Parts: 45 pieces. Each cradle has 11 (plate, ledge, two rails, two struts, three
keys, foot, foot bar); the shelf has 7 (two sides, two treads, tie, two stop
bars); the coupon has 5.

Engraved labels give each part's name, the device and "Ghost Jack bench". Parts
too small for all three words use "GJ BENCH", and the wedge keys say only "KEY"
(keep them in one bag).

## How it works

- **Back plate**: the board leans on it. Slots in the plate take the ledge (two
  tabs), the two rails (two tabs each) and the two struts. Angle numbers are
  engraved beside each strut slot.
- **Ledge** (the lip): a shelf the board stands on; the Pi's ledge has a notch
  for its USB ports. **Rails**: keep the board from sliding sideways; the CYDs'
  left rail has a notch for the USB plug.
- **Struts** (the kickstand): a strut's tab goes through the plate slot beside
  an angle number, and a **wedge key** through the tab's hole locks it. Put the
  tab in the slot labeled with the angle you want (both sides the same). The
  strut points back and down at a right angle to the plate and its tip rests on
  the deck. The slots are placed so the strut tip lands on the deck at that
  angle: `height = strutLength x tan(angle) + strutWidth / 2`.
- **Foot**: one flat deck with a stop bar at its front. A cradle stands behind
  the bar, which stops its bottom from sliding forward. Use it to run one cradle
  alone.
- **Shelf**: two treads at different heights (`stepHeight` 40) held by two
  stair-shaped sides and a tie bar. Each tread takes a stop bar; up to three
  cradles stand side by side on each. The shelf is as wide as the three cradles
  plus gaps.

## Assembly

1. Cut the coupon, pick `fitOffset`, rebuild, cut the cradle sheets.
2. Push each strut's tab through a slot of the plate: strut on the plate's back
   (engraved) face, tab coming out the front. Both struts into the same angle.
   Slide a wedge key (thin end first) across the hole in each tab, flat against
   the plate's front face, and tap it snug. Take it out with a tap on the thin
   end.
3. Push the ledge's tabs through its two slots at the plate's bottom, then each
   rail's two tabs through its slots (the notched rail on the USB side). Tabs
   sit flush with the plate's back.
4. Stand the board on the ledge, between the rails, with its back to the plate.
   Check the USB cable reaches through its notch.
5. For one cradle: push the foot bar's three tabs through the foot's slots, then
   stand the cradle behind the bar, plate bottom against it.
6. For the shelf: slide each tread's side tabs into its stair-shaped side, tie
   bar between the sides near the bottom, a stop bar in each tread, then stand
   cradles behind the bars. Three cradles fit on each tread.

If joints are loose after a humid week, press a strip of paper into the slot. If
a board is too tight between the rails, raise `boardClear` and rebuild.

## Files

- `build.mjs`: the script (sheets, previews, checks, assembly drawing)
- `params.mjs`: all dimensions and the command line
- `parts.mjs`: every part's shape; `sheets.mjs`: packing and SVG; `check.mjs`:
  the self-check; `diagram.mjs`: the assembly drawing; `font.mjs`: the
  pixel-rectangle label font; `geom.mjs`: geometry helpers
- `out/`: generated sheets and previews (drawings, not camera media)
