# Flight Sim

A small single-engine flight simulator built on [three.js](https://threejs.org/) (r160, vendored
in `vendor/`). No build step and no server: open `index.html` in a browser and click
**Click to fly**. Works offline.

**Play it online:** https://denzy7.github.io/test-threejs/ (GitHub Pages, deployed from `main` on
every push). Settings saved there are separate from a copy opened from disk.

## Flying

- **Take off:** full power (`R`), let it accelerate down runway 36 — at the takeoff trim it lifts off
  by itself around 70 kt, or ease `S` back at 60 kt. Gear up with `G` once climbing.
- **Cruise:** about 75% power with neutral trim holds roughly 100 kt level (gear up). Trim sets
  your speed, power sets climb or descent.
- **Land:** `Y` puts you on the ILS 36 approach (flaps 15, trimmed). Follow the HSI needles or the
  PAPI (2 white + 2 red = on the glide path), close the throttle over the threshold and flare with
  a few taps of `S`.

## Default keys

All of these can be rebound in **Settings** (`Esc` or the ⚙ button). Settings and bindings are saved
in your browser (localStorage) only.

| Keys | Action |
|---|---|
| `W` / `S` (or ↑ / ↓) | pitch down / up |
| `A` / `D` (or ← / →) | roll |
| `Q` / `E` | rudder / nose-wheel steering |
| `;` / `.` | trim nose down / up |
| `R` / `F` | power up / down |
| `B`, `Shift+B` | brakes (hold), parking brake |
| `G` | gear |
| `1` / `2` | flaps up / down |
| `3` `4` `5` `6` | landing light, taxi light, nav lights + beacon, strobes |
| `L`, `Shift+L` | tune next / previous NAV station (ILS 36, VORs) |
| `9` / `0` | VOR course − / + |
| `[` / `]`, `\` | altimeter setting, set to QNH |
| `C`, `V`, drag, wheel | camera (chase / cockpit), recenter, look around, zoom |
| `M`, `-` / `=` | map / GPS, GPS range |
| `U`, `H`, `K` | instrument panel, help, FPS counter |
| `X`, `N` | weather panel, day / dusk / night |
| `T`, `Y`, `P` | reset on runway, air start on approach, pause |
| `Z` | replay |
| `O`, `I` | sound, invert pitch |

## Replay

`Z` replays the last 10 minutes of flight, starting 30 s back. Every camera view,
instrument and the map work as normal during playback. `Space` plays / pauses, `←` / `→` seek 5 s
(30 s with `Shift`), `↑` / `↓` change speed (¼× to 4×), `Home` / `End` jump to either end, or drag
the scrubber. `Esc` or `Z` returns to where you were; `Enter` (**Take control**) drops everything
after the moment on screen and lets you fly on from there, which is handy for retrying a landing.

## What's in it

- **Two flight models** (Settings → Flight model):
  - *Standard* (default, forgiving): lift-based with angle-of-attack stability, trim, flaps (with
    balloon), ground effect, propeller thrust that falls with airspeed, pitch/yaw inertia, crosswind
    weathervaning, gentle stalls.
  - *Realistic* (6-DOF): a rigid body with Cessna-172-class mass, inertia and stability/control
    derivatives; elevator/aileron/rudder deflections, adverse yaw, rudder-induced roll, a real
    phugoid, 160 hp engine with propeller torque, P-factor and slipstream (right rudder on takeoff),
    rotation when the elevator beats the nose-wheel load, wing drop at the stall and spins. About
    680 fpm climb at 77 kt, ~120 kt cruise.
- **Atmosphere:** temperature lapse rate, QNH, air density (lift, drag and engine power), IAS vs
  TAS, density altitude, altimeter temperature error.
- **Weather:** presets (ISA, VFR, NPA, CAT I–III) or custom visibility, cumulus or overcast layers,
  wind with gusts and variable direction, temperature / dew point, QNH; live METAR.
- **Instruments:** six-pack with an HSI (ILS localizer/glideslope, VOR course with TO/FROM, marker
  beacons, DME) and a GPS-style unit with moving map, flight data, and throttle / trim / flaps /
  gear readouts.
- **Navigation:** ILS 36 (I-XSN 110.30) and four VOR/DMEs — XSM 113.40 (on the field, RW18 VOR
  approach), KRA 115.80, WSN 112.70, NCP 116.20. The big map (`M`) zooms and pans; click a VOR or
  the ILS feather to tune it.
- **Airport:** runway 18/36 with full markings, PAPIs both ends, approach and runway lighting,
  taxiways, apron, hangars, windsocks, rotating beacon.
- **Night:** day / dusk / night lighting, stars, aircraft landing / taxi / nav / strobe / beacon
  lights.
- **Sound:** synthesized engine, wind, rolling, stall horn, gear/flap motors, marker tones.

## Files

- `index.html` — page markup, styles, HUD / panel / settings elements
- `sim.js` — the sim: scenery, flight model, instruments, nav, weather, sound, input, settings.
  A classic script (not an ES module) so it loads when the page is opened straight from disk.
- `vendor/three.min.js` — three.js r160 (classic build, MIT, see `vendor/three.LICENSE`)
- `TODO` — the to-do list

## License

MIT, see `LICENSE`. three.js (in `vendor/`) is also MIT, see `vendor/three.LICENSE`.
