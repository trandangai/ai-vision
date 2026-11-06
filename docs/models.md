# Adding an object

An object in TakeApart is a **JSON file**. You do not need to write any JavaScript: you describe the object as a
list of named parts, each part as a list of shapes, and the app does the rest — sampling it into particles,
colouring it, exploding it, labelling it, reading it aloud and quizzing on it.

## Two ways in

**Drop it in (no repo, no reload).** Write your `.json` file, then drag it onto the running app — or open the
model picker at the bottom and press **Add your own object**. It is compiled on the spot, selected, and
remembered in that browser so it is still there next time. Your own objects carry a small **×** in the picker
to remove them again.

Nothing is uploaded anywhere: the file is read locally and stays in your browser. To hand an object to someone
else, send them the `.json` file, or host it and share a link with `?load=`:

```
http://localhost:5173/?load=/my-objects/desk-lamp.json
```

**Ship it with the app.** For objects that should always be there — a museum's own exhibits, a course's model
set — put the file in `src/models/objects/` and add its name to the manifest:

```
src/models/objects/
  manifest.json      the list of files to load
  wind-turbine.json  one object
```

```json
{ "objects": ["wind-turbine.json", "my-thing.json"] }
```

Either way the object behaves like every built-in model: gestures, exploded view, part labels, read-aloud,
voice commands and the quiz.

If a file has a mistake nothing breaks: a dropped file is refused with the reason shown in the picker, and a
bundled one is skipped at startup. Either way the message names the field, the part and the file:

```
[declarative model] my-thing.json (My Thing).parts[2] "Rotor" (gear).r: expression "radus * 2"
  -> unknown name "radus" (variables here: radius, n, i, t, f; constants: DEG, E, GOLDEN, ...)
```

`src/models/objects/wind-turbine.json` is a complete worked example: 13 parts, repeated blades, a twisted
aerofoil surface and bearings placed with trigonometry.

---

## A minimal template

```json
{
  "name": "Desk Lamp",
  "category": "Machines",
  "fact": "45 cm reach · 1950s design",
  "color": [1.0, 0.8, 0.4],
  "tilt": 10,
  "viewYaw": 0.6,
  "parts": [
    {
      "label": "Shade",
      "info": "throws the light down onto the desk",
      "color": "amber",
      "offset": [0, 40, 0],
      "stage": 0,
      "shapes": [
        { "type": "revolve", "ys": [0, 12], "rs": [4, 11], "center": [0, 30, 0], "density": 1 },
        { "type": "ring", "center": [0, 30, 0], "r": 11, "density": 5 }
      ]
    },
    {
      "label": "Base",
      "info": "weighted so the lamp does not tip over",
      "color": "steel",
      "offset": [0, -25, 0],
      "stage": 0.3,
      "shapes": [
        { "type": "cylinder", "center": [0, 0, 0], "r": 9, "h": 2.5, "cap": true, "density": 1.5 }
      ]
    }
  ]
}
```

Two parts is the minimum. Six or more labelled parts is where exploding an object starts to teach something.

---

## The model

| Field | Required | What it is |
|---|---|---|
| `name` | ✅ | Shown in the HUD and used by voice commands ("show me the desk lamp") |
| `category` | ✅ | The tab it appears under: `Landmarks`, `Anatomy`, `Biology`, `Engines`, `Vehicles`, `Machines`, or a new name of your own (which creates a new tab) |
| `parts` | ✅* | The named parts — this is what makes an object explodable |
| `shapes` | ✅* | *Instead of* `parts`: a single-colour landmark that morphs into the next one, with no parts to pull apart |
| `color` | | The model's overall glow, `[r, g, b]` in 0..1 or a [colour name](#colours). Default: pale blue |
| `fact` | | One line under the title: "80 m hub · 90 m rotor · 2.5 MW" |
| `tilt` | | Degrees it leans toward the viewer (0–30 looks natural). Default `0` |
| `viewYaw` | | The ¾ angle, in radians, the exploded view eases round to. `0.5`–`0.7` suits most objects |
| `vars` | | Named numbers reused across the file — see [variables](#variables) |
| `pulse` | | `{ "bpm": 72, "amp": 0.05 }` — makes it beat, like the heart |
| `breath` | | `{ "period": 4.5, "amp": 0.08 }` — makes it inflate and deflate, like the lungs |
| `units`, `note`, `source` | | Free text for whoever reads the file next. Ignored by the app |

\* exactly one of `parts` or `shapes`.

**Coordinates:** y is up, the viewer looks at the +z face, and the units are yours — metres for a building,
millimetres for a watch. The whole model is scaled to fit the globe at the end, so only the *proportions*
matter. Use real measurements: it is what makes these models worth looking at.

## A part

| Field | Required | What it is |
|---|---|---|
| `label` | ✅ | The name on the leader line. Must be unique within the model |
| `color` | ✅ | `[r, g, b]` or a [colour name](#colours) |
| `offset` | ✅ | `[x, y, z]`: where the part travels in the exploded view, in model units. Think of it as "which way does this come off?" |
| `stage` | ✅ | `0` to `0.6`: when it starts to move as the hand opens. Outer covers `0`, deep internals `0.4`+ |
| `shapes` | ✅ | The geometry (below) |
| `info` | | What the part *does*, in a few words: shown under the label and read aloud. Write one for every part |
| `mirror` | | Make a mirrored twin — see [mirror](#mirror) |
| `showLabel` | | `false` hides the leader line (for a part that is part of another part's story) |
| `vars` | | Variables for this part's shapes only |

Explode offsets are what make an exploded view readable. Send a lid up, a sump down, an intake one way and the
exhaust the other, and spread parts across **x** too, or every leader line ends up stacked down one edge.

## Shapes

Every shape is `{ "type": "...", ...arguments }`. Any argument that is a number can be written as an
[expression](#expressions) string instead.

**Lines and flat pieces**

| Type | Arguments |
|---|---|
| `line` | `from`, `to`, `r` (scatter), `density` |
| `polyline` | `points`, `r`, `density`, `closed` |
| `tri` | `a`, `b`, `c`, `density`, `keep` |
| `quad` | `a`, `b`, `c`, `d`, `density`, `keep` — corners in order around the face |
| `disc` | `center`, `r0` (hole), `r1`, `axis`, `density`, `keep` |
| `ring` | `center`, `r`, `sx`, `sz` (ellipse), `jitter`, `density` |

**Boxes**

| Type | Arguments |
|---|---|
| `box` | `center`, `size`, `density`, `edge` — faces plus bright edges, the everyday solid block |
| `boxSurface` | `center`, `size`, `density`, `keep`, `top`, `bottom` |
| `boxEdges` | `center`, `size`, `r`, `density` — wireframe only |

**Round things**

| Type | Arguments |
|---|---|
| `revolve` | `ys`, `rs` (a profile spun around the y axis), `center`, `sx`, `sz`, `arcFrom`, `arcTo` (degrees), `density`, `keep` |
| `cylinder` | `center`, `r`, `h`, `cap`, `capBottom`, `density`, `keep` |
| `sphere` | `center`, `r`, `density` |
| `ellipsoid` | `center`, `radii`, `density`, `keep` |
| `torus` | `center`, `r`, `tubeRadius`, `axis`, `density` |
| `helix` | `center`, `r`, `h`, `turns`, `axis`, `density` — springs and windings |
| `gear` | `center`, `r`, `teeth`, `depth`, `width`, `hub`, `axis`, `density` |

**Tubes and organic shapes**

| Type | Arguments |
|---|---|
| `tube` | `from`, `to`, `r`, `r1` (taper), `density` |
| `pipe` | `points`, `r`, `density` — straight runs between points |
| `vessel` | `points`, `r`, `r1`, `smooth`, `density` — a *smooth* tapering tube through the points: veins, cables, blades |
| `capsule` | `from`, `to`, `r`, `density` |
| `bone` | `from`, `to`, `r`, `density` — a shaft with knobbly ends |
| `blob` | `center`, `radii`, `bump` (expression in `u`, `v`), `vFrom`, `vTo`, `grid`, `density`, `keep` |
| `dots` | `points`, `r`, `density` — a fuzzy cloud at each point |
| `surface` | `x`, `y`, `z` (expressions in `u`, `v`), `u`, `v` ranges, `grid`, `density`, `keep` |

### density

`density` (default `1`) is how thickly a shape is sprinkled relative to everything else in the model — not a
point count. Particles are shared out by area × density, so a 70 m tower naturally gets more than a 20 cm
sensor. Raise `density` on small parts that matter and on outlines you want to glow; lower it on big dull
surfaces. Build the object first, then adjust until every part reads.

### keep

`keep` cuts holes. It is an expression in `x`, `y`, `z` that is true where particles survive:

```json
{ "type": "quad", "a": [0,0,0], "b": [10,0,0], "c": [10,10,0], "d": [0,10,0],
  "keep": "hypot(x - 5, y - 5) > 2" }
```

It is tested in the shape's **own** coordinates, before `rotate` and `translate` move it.

### Placing shapes

Any shape accepts these, applied in this order:

| Key | Effect |
|---|---|
| `repeat` | Build it `n` times, or `[n, m]` times for a grid — see [repeat](#repeat) |
| `rotate` | `{ "x": 90, "z": "i * 120" }` degrees, applied X then Y then Z, about the origin |
| `translate` | `[x, y, z]`, after rotating |
| `mirror` | `"x"`, `"y"` or `"z"`: adds a mirrored copy to the same part |
| `note` | A comment for human readers (JSON has none) |

Shapes with an `axis` argument (`disc`, `torus`, `helix`, `gear`) are built facing `"y"` by default and can be
pointed with `"x"`, `"z"`, `"-y"` ... or an arbitrary `[x, y, z]` direction.

---

## repeat

`repeat` builds the same shape many times, with these variables in scope:

| | |
|---|---|
| `i` | 0, 1, 2, … |
| `n` | the total |
| `t` | `i / (n - 1)` — runs 0 → 1 **inclusive**, for a row that spans a distance |
| `f` | `i / n` — runs 0 → just under 1, for things arranged **around a circle** |

Six bolts on a circle, and tick marks every 10 metres:

```json
{ "type": "cylinder", "repeat": 6, "r": 0.3, "h": 1,
  "center": ["20 * cos(f * TAU)", 0, "20 * sin(f * TAU)"] }

{ "type": "ring", "repeat": 8, "r": 2, "center": [0, "t * 70", 0], "density": "i % 5 == 0 ? 6 : 2" }
```

`"repeat": [3, 4]` makes a grid and adds `j`, `m`, `s` and `g` (the same four meanings on the second axis):

```json
{ "type": "box", "repeat": [4, 7], "size": [6, 2, 6],
  "center": ["i * 8 - 12", 0, "j * 8 - 24"] }
```

## Variables

`vars` names numbers so a model stays editable. Model-level `vars` are visible everywhere; a part can add its
own, and each may build on the ones before it:

```json
"vars": { "hub": 80, "blade": 43, "tip": "hub + blade" }
```

## mirror

Most objects are symmetrical. `mirror` on a **part** makes a twin that is highlighted, pulled and read aloud
together with the original, labelled `" (L)"` and not given its own leader line:

```json
{ "label": "Door", "info": "...", "color": "steel", "offset": [0, 0, 60], "stage": 0.1,
  "mirror": "z",
  "shapes": [ ... the right-hand door ... ] }
```

The twin's explode offset is mirrored too, so the pair opens outward. Use `{ "axis": "z", "suffix": " (L)",
"offset": [0, 0, -70] }` to say exactly where the twin goes. `mirror` on a single **shape** just doubles that
shape inside the same part.

## Expressions

Any number may be a string of arithmetic. There is no `eval` here and expressions cannot reach anything except
the values below, so a model file can never run code.

- `+ - * / % ^`, parentheses, and `? :`
- `< <= > >= == != && || !` (true is 1, false is 0)
- Constants: `PI`, `TAU` (2π), `E`, `DEG` (degrees → radians), `SQRT2`, `GOLDEN`
- Functions: `abs acos asin atan atan2 cbrt ceil clamp cos deg exp floor hypot if lerp log max min mod pow round sign sin smoothstep sqrt step tan trunc`
- Whatever variables are in scope: your `vars`, and `i n t f` / `j m s g` inside a `repeat`, `x y z` in a
  `keep`, `u v` in a `surface` or `blob`

```json
"z": "(v - 0.3) * lerp(rootChord, tipChord, u) * sin((1 - u) * 12 * DEG)"
```

## Colours

`steel`, `orange`, `gold`, `white`, `red`, `teal`, `purple`, `green`, `pink`, `cyan`, `silver`, `lime`,
`amber`, `magenta`, `ice`, `blue`, `grey`/`gray`, `yellow`, `bone`, `copper`, `glass`, `carbon`, `flame`.

Or `[r, g, b]` with each channel 0–1. These are **emissive** colours on a black background: light, saturated
values glow; dark ones disappear. Give neighbouring parts clearly different hues — that is how someone reads an
exploded view at a glance.

---

## Checklist before you ship an object

- [ ] Every part has an `info` line saying what it *does*
- [ ] Offsets send parts in sensible directions, spread across x, y **and** z
- [ ] Outer covers have `stage: 0`, the deepest internals around `0.4`
- [ ] Six or more labelled parts, so quiz mode has something to ask
- [ ] Measurements are real
- [ ] `npm test` passes — `tests/declarative.spec.js` checks every object in the manifest: determinism, finite
      points, every part getting particles, the exploded view fitting on screen, and an `info` on every label

To see the particle split per part while you tune `density`, open the app, form the object and press `L` for
labels — or run the test above, which prints a table of parts per model.
