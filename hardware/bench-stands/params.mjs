// Every dimension of the bench stands, in millimeters. Each number can be
// overridden on the command line (`--thickness 3.1 --Pi.length 66`); every
// device number is a typical published value: measure and confirm (README).

export const DEFAULTS = {
  // Material and joints
  thickness: 3.0, // plywood; Glowforge 1/8" measures about 3.0 to 3.2
  kerf: 0.15, // width of the laser cut, taken off drawn slots
  fitOffset: 0.0, // joint looseness; pick it from the test coupon
  tabWidth: 12, // length of a joint tab along its edge
  // Cradle
  boardClear: 0.6, // slack between a board and each side rail
  ledgeHeight: 10, // ledge underside above the back plate's bottom edge
  strutLength: 40, // kickstand body, tip to plate
  strutWidth: 14, // kickstand body width
  strutTabWidth: 8, // kickstand tab width (through the plate)
  keyHole: 6, // wedge key hole length along the tab
  angles: [15, 30, 45, 60], // degrees from vertical, one notch each
  // Shelf
  stepHeight: 40, // the two steps of the shelf, tread to tread
  shelfBase: 28, // shelf side height under the low tread
  shelfGap: 6, // free tread width between cradles
  stopHeight: 9, // stop bar height above its tread
  // Devices: length x width = the board seen from the screen, landscape;
  // stack = thickness from the back of the board to the top of the screen.
  devices: {
    pi: {
      name: 'Pi Zero W + e-Paper',
      short: 'PI ZERO',
      length: 65, // measure: Pi Zero long edge (the HAT matches it)
      width: 30, // measure: Pi Zero short edge
      stack: 15, // measure: Pi + headers + HAT, back to screen face
      // Cable notches cut from the ledge's front edge: [from, to] in mm
      // along the long edge from the left; micro USB data and power sit
      // about 41 and 54 mm from the left (measure; mini HDMI at about 12).
      ledgeNotches: [[36, 62]],
      railNotch: null,
    },
    cyd28: {
      name: 'CYD 2.8 inch',
      short: 'CYD 2.8',
      length: 86, // measure: ESP32-2432S028 long edge
      width: 50, // measure: short edge
      stack: 10, // measure: PCB back parts to screen face
      ledgeNotches: [],
      // USB on a short edge: a notch in the left rail, centered this far
      // up from the board's bottom edge, this wide (measure)
      railNotch: { center: 25, width: 14 },
    },
    cyd35: {
      name: 'CYD 3.5 inch',
      short: 'CYD 3.5',
      length: 98, // measure: ESP32-3248S035 long edge
      width: 55, // measure: short edge
      stack: 11, // measure: PCB back parts to screen face
      ledgeNotches: [],
      railNotch: { center: 27, width: 14 },
    },
  },
};

/** Parse `--name value` pairs; `--Pi.length 66` reaches into a device. */
export function parseParams(argv) {
  const P = structuredClone(DEFAULTS);
  const known = new Set(['no-png']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) throw new Error(`unexpected argument ${a}`);
    const key = a.slice(2);
    if (known.has(key)) {
      P[key] = true;
      continue;
    }
    const val = argv[++i];
    if (val === undefined) throw new Error(`${a} needs a value`);
    if (key === 'out') {
      P.out = val;
    } else if (key === 'angles') {
      P.angles = val.split(',').map(Number);
    } else if (key.includes('.')) {
      const [dev, field] = key.split('.');
      if (!P.devices[dev]?.[field] && P.devices[dev]?.[field] !== 0) {
        throw new Error(`unknown device setting ${key}`);
      }
      P.devices[dev][field] = Number(val);
    } else if (typeof DEFAULTS[key] === 'number') {
      P[key] = Number(val);
    } else {
      throw new Error(`unknown setting ${a}`);
    }
  }
  return P;
}
