# Table Saw

An interactive cabinet saw. The companion piece to the centre lathe, and it
is deliberately the opposite case.

## The lesson

On the lathe the diameter under the tool is the thing you are changing, so
the cutting speed moves while you work and nothing can hold it still. A saw
inverts that: one blade, one diameter, one speed. `v = πDn` comes out at
about **55 m/s at the rim and stays there**, and there is no gearbox to
change it.

What is left to get wrong is how the feed is shared out between the teeth:

```
f_z = v_f / (n × Z)          mm of timber per tooth
```

- below **0.012 mm** the edge cannot get under the fibres. It stops cutting
  and starts rubbing, and rubbing timber at fifty metres a second sets fire
  to it — a burn mark is a *slow* blade, not a blunt one;
- above **0.055 mm** the tooth takes more than its gullet can carry, so the
  edge levers instead of slicing and the face splinters.

Both marks are recorded **against the board**, at the station the blade was
passing when they happened. Change the feed halfway down a cut and you can
see exactly where you changed it.

## What is modelled

| | |
|---|---|
| Motor | 1.8 kW four-pole induction, 1725 rpm, 1656 W at the arbor after the belt |
| Drive | Toothed belt, 40T motor to 20T arbor — a 2:1 step **up**, 1725 rpm in, 3450 out |
| Blade | 305 mm, 3.2 mm kerf, 24T rip / 40T combination / 80T crosscut |
| Timbers | Pine 22, MDF 38, plywood 45, oak 60 N/mm² specific cutting force |
| Teeth in cut | from the engagement arc, so blade height and stock thickness both change it |
| Bevel | `projection = h cos β` — 98 mm at 90° gives 69 mm at 45°, which is what a real 12" saw is sold as cutting |

## The assembly

Everything under the table is a working mechanism, and the **Cabinet** switch
takes away only the sheet steel — the frame, the drive and both adjustment
trains stay where they are, because the skins carry no load.

- **Height**: wheel → splined shaft on a universal joint → bevel pair →
  elevation screw → carriage nut → arbor. 6 mm of blade per turn of the wheel.
- The blade **guard** is not fitted, so the blade and the cut are visible. The
  **riving knife** is, and stays: it is a different part, and the one that
  stops a closing kerf gripping the back of the blade.
- **Tilt**: wheel → shaft → worm → toothed quadrant on the cradle. A worm
  because it cannot be driven backwards, and the weight of the motor hanging
  off the trunnion would otherwise wind the blade back to square.
- The trunnion **brackets are fixed** to the underside of the table and the
  cradle **rides** them, which is why the blade stays in its own slot at any
  angle. The motor is bolted to the cradle, so it goes over with everything
  else and the belt never has to change length.

## Files

- `index.html` — page, controls and the learning-outcomes sheet
- `app.js` — physics, the machine in three dimensions, and the controls
- `app.css` — shared with the other simulations in this set
- `vendor/` — three.js, Tailwind, Font Awesome, fonts and audio, all local

Runs entirely offline. No CDN, no build step: open `index.html`.
