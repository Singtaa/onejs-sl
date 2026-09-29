# onejs-sl

The OneJS shader language: a small typed language for per pixel programs. A
program is written as a `.sl` file (HLSL text) or with the TypeScript form, and
recorded as one portable IR, a flat typed graph with a hash. The package emits
that IR as a Unity ShaderLab shader, WGSL and GLSL ES.

It is the compiler [OneJS](https://onejs.com) uses, taken out of `onejs-unity`
so a host without Unity can run it too. `onejs-unity/sl` and
`onejs-unity/sl/compiler` re-export it, so nothing in a OneJS project imports
this package directly. User documentation is the
[shader language guide](https://onejs.com/docs/guides/shader-language); this
file is the design.

```ts
import { parse, sl } from "onejs-sl"

const ripple = parse(`float4 main() {
    float v = sin(length(uv - 0.5) * 40 - time * 4);
    return float4(v * 0.5 + 0.5, 0, 0, 1);
}`, { file: "ripple.sl" })

const plasma = sl.program(({ uv, time }) => {
    const p = uv.mul(8).add(time.mul(0.4))
    const v = sl.sin(p.x).add(sl.sin(p.y))
    return sl.vec4(v.mul(0.5).add(0.5), 0, 0, 1)
})
```

## Entry points

`"sideEffects": false`, and each backend is its own entry, so a host bundles
only what it calls.

| Entry | Contents |
|---|---|
| `onejs-sl` | `parse` and `analyze`, `diagnose` (every error in a file, not just the first), `classify` (every token with its class, comments kept, never throws), `fromGLSL` (a pasted Shadertoy or WebGL shader as a `.sl` file, with notes on what did not carry over), the TypeScript form `sl`, the IR types, `SL_IR_VERSION`, `toJSON`/`fromJSON`, `SLParseError` (file, line, column, offset, length, the bare `text`, and a `fix` where one is certain) |
| `onejs-sl/core` | the same without the parser: what a game needs at run time. Also the caps on one program, `UNIFORM_SLOTS` (16) and `TEXTURE_SLOTS` (4), which the parser and the builder enforce and a host can read |
| `onejs-sl/tables` | `BUILTINS`, `SL_HLSL`, `INPUTS`, `SL_SDF_SHAPES`, `SL_SDF_PARAMS`, `SL_KEYWORDS`, `SL_TYPES`, `TYPE_WIDTH`, `PRELUDE_NAMES`: what completion and highlighting read. `BUILTIN_PARAMS`, `SL_SDF_PARAM_NAMES` and `LIB_SIGNATURES` name every parameter, so an editor can show `lerp(x, y, s)`, and `BUILTIN_DOCS`, `INPUT_DOCS` and `PRELUDE_DOCS` give each a line for its tooltip |
| `onejs-sl/compile` | `compile(program)`: what a host draws a program with. Its hash, its uniform and texture names in slot order, their defaults, and `hlsl`, `wgsl` and `glsl` as lazy getters. No budget |
| `onejs-sl/emit/hlsl-body` | `emitBody`: a program as a function body for a host's own frame; `emitLibrary`: the library functions it calls |
| `onejs-sl/emit/unity` | `emitShader`: the `.shader` a Unity editor generates, a frame over `emitBody` |
| `onejs-sl/emit/web` | `emitWGSL`, `emitGLSL`: OneJS's web frame |
| `onejs-sl/goldens.json` | the goldens (below), as data |

`src/entries.test.ts` pins every name, since removing one breaks a host.

## A host's own frame: `emitBody`

`emitBody(program, target)` prints the body only: one local per node, in the
HLSL and Metal shared subset (HLSL spelling, `fmod`, no `mul`, no `static`, no
derivatives, no swizzle of a scalar, and every literal and scalar in an
intrinsic at its exact type, since Metal overloads where HLSL converts). The `BodyTarget` says what differs between hosts: an expression
for each input, the float4 holding a uniform slot, a texture sample and a
sample at a mip level (`sampleLevel`, for `tex2Dlod`), whether
`toLinear` is real (`colour: "linear"`) or the identity (`"gamma"`), and
optionally a local to assign the result to. A host that steps a program frame
by frame adds `frame` and `deltaTime` to its inputs and a `previous` read (below,
"What a program is given"); a target without one cannot draw a program that
reads it, and `emitBody` says which is missing rather than print a shader that
stands still. It returns the uniform and texture
slots the body uses and the library functions it calls. The sample's contract
is on `BodyTarget.sample`: straight alpha in and out, rgb in the space `colour`
names (an sRGB texture decoded before filtering when it is `linear`), and
filtering and wrapping left to the host, which OneJS's hosts take from the
bound texture's own settings. OneJS's Unity shader is
one frame over it (`hlsl.ts`); Magerie's compute kernel is another, and its
target is in `src/body.test.ts` so an opcode cannot change without the text
Magerie compiles changing in front of a test.

`emitLibrary(body.uses.helpers, colour)` prints the library functions the body
calls, and everything they call, in the same subset and dependency order, with
the colour branch asked for: the text a host puts ahead of its frame. It is a
separate call because OneJS's own frame never needs it (the Unity shader
includes `SLCommon.cginc`), and a bundle that prints only Unity shaders should
not carry the library too. On a Mac with Xcode, `src/metal.test.ts` compiles
the whole library and a body for every corpus program and every builtin at
every width as Metal, behind the two defines a host's compatibility header
supplies (`frac`, `lerp`).

A uniform declared with a hex default (`uniform float4 tint = #ff8040;`), or
with `sl.uniform.colour`, is marked `colour: true`: its value is sRGB as
written, which is what a colour picker shows, and its reads convert. A
`uniform int`, or `sl.uniform.int`, is marked `kind: "int"`: its slot is a float
like any other, its default is a whole number that slot holds exactly, and the
program reads it as one, so a host shows a whole number field; a float uniform
has no `kind`. Neither mark is in the hash, since the reads' conversion already
is. `inputsUsed`
says which inputs the result depends on, dead nodes aside, so a host knows
whether a program animates, and `readsOf` (also `compile(p).reads`) says which
of the previous frame, `frame` and `deltaTime` it needs kept between frames.

## The helper library: one source

Value and simplex noise, the octave kinds, voronoi, hsv2rgb, `toLinear` and the
42 distance shapes are written once, in HLSL, in `lib/sdf2d.hlsl`,
`lib/noise2d.hlsl` and `lib/common.hlsl`. Everything else is printed from them
by `npm run lib`, and nobody edits the copies:

- **OneJS's `.cginc` files** (`SDF2D`, `Noise2D`, `SLCommon` in
  `Resources/OneJS/`) are the source with an include guard and a generated
  header around it. The generated Unity shaders and `fx` include them.
  `npm run lib` writes them when the package sits in the OneJS container.
- **`src/lib/`**: `table.ts` (every function, its signature, what it calls, and
  the shape table read from `sl_sdfDistance`'s switch), and the text of each
  function as GLSL ES (`glsl.ts`), WGSL (`wgsl.ts`) and the shared subset
  (`hlsl.ts`). The web emitters and `emitLibrary` take only what a program calls.
  `names.ts` holds each function's parameter names, which only
  `onejs-sl/tables` reads.

`lib/translate.ts` does the printing, at build time only. It reads a subset of
HLSL, listed at its top (functions, locals, `if`, bounded `for`, `switch`,
intrinsics, `mul(v, float2x2(...))`, `uint` and `uint2` for the hashes, and one
preprocessor switch, `UNITY_COLORSPACE_GAMMA`, which becomes the target's
colour), and anything
outside it is an error with a file and line rather than a guess. HLSL converts
where GLSL, WGSL and Metal refuse, so it makes every conversion explicit first;
the printers then differ in spelling, plus what WGSL lacks (overloading,
ternaries, swizzle assignment, assignable parameters). On the web the colour
switch stays a runtime branch on the frame's `opt.x`, since a web build does not
know the project's colour space when it prints.

`src/lib/lib.test.ts` regenerates everything and fails on any byte of
difference, the `.cginc` copies included in the container, and OneJS's
`SLSharedLibraryTests` checks them from the other side. What proves the
translations draw the same picture: the goldens compile the whole library on
WebGPU and WebGL2 and draw every fixture; OneJS's parity harness draws every
fixture through a real WebGL player and holds it to the goldens; `SLSharedLibraryTests` draws every corpus program in Unity
through `SLCommon.cginc` and through the translated shared subset and requires
them to agree; and the Metal check above compiles the shared subset.

## Goldens

`goldens/goldens.json` is every corpus fixture drawn as a Linear OneJS game
stores it: the package's WGSL and GLSL ES in OneJS's web frame, into an
`rgba8unorm-srgb` target (the format the element's render texture has), read
back raw, with no Unity, no UI Toolkit and no browser colour management. The
goldens stand on their own: the two backends must agree, and the anchors and
the hash probes must match arithmetic. A host's own backend is checked against
them, as OneJS's parity harness (`Tools/sl-web-parity` in the container) checks
what a WebGL player draws.

`npm run goldens` draws it on WebGPU and WebGL2 in a Chrome with its own
profile (set `CHROME` to choose one). The two backends must agree within 1/255
over every pixel, and seven anchors must match arithmetic, not each other:
`orient.sl` (orientation, and the linear to sRGB store), `hex.sl` (a hex colour
stores as written), `texture.sl` (a texture's orientation and sRGB decode) and
`lod.sl` (each mip level `tex2Dlod` reads, the texture's smaller levels being
solid colours). `sdf-values.sl`, `fbm-values.sl` and `ramp-values.sl` are black unless a
shape, a noise or a ramp draws differently with its parameters as values than
as constants.
A fixture that reads the previous frame, `frame` or `deltaTime` is stepped
instead of drawn at times: eight frames at 1/30 of a second, into an
`rgba16float` history pair that starts clear, each frame then copied into the
target as an element shows it. goldens.json holds its samples at frames 0, 1
and 7, as shown and as the raw history. Three are anchors on the history, to
the bit: `counter.sl` (a step taken twice, a missed swap or 8 bit history),
`drift.sl` (the previous frame read upside down) and `frame-delta.sl` (`frame`
and `deltaTime` as a host hands them over); `trail.sl` is the fading trail the
docs show.
The whole translated library must also compile on both backends, including
the functions no fixture reaches. The file describes the sampling grid, the
times and the texture every sampled slot gets. A host imports it as
`onejs-sl/goldens.json`.

The hashes are held to the bit, not to 1/255: two backends that happen to round
alike prove nothing about a third. `goldens/probes.hlsl` draws each of the
library's hashes (`hash21`, the value noise's, and `hash22`, voronoi's) as three
bits per pixel, and `corpus/probe-hash.sl` does the same through a program;
every pixel must match `goldens/reference.mjs`, which computes the hashes in
JavaScript. goldens.json ships each probe under its name, as HLSL, WGSL and
GLSL ES and with the bits it must draw, for a host to run on its own compiler,
and marks the fixtures compared at 0/255 `exact`, and the stepped fixtures
whose history is compared to the bit `historyExact`.

`npm run goldens -- --check` draws everything again and compares it with
goldens.json instead of writing it: within 1/255, and exact fixtures and probes
to the byte. It is how a machine that did not write the file checks its own
GPU and compilers. No CI runner here has a GPU, so `src/goldens.test.ts` checks instead
that the file still covers the corpus at today's hashes; a change that moves a
hash fails there until the goldens are drawn again.

## Runs anywhere ES2020 runs

The source reaches for no host API: no `fs`, `process`, `Buffer`,
`TextEncoder`, `performance`, `structuredClone` or `Intl`. It runs in a
browser (the Play editor's diagnostics), a Cloudflare worker (the Play build)
and QuickJS (Magerie). Three checks hold it to that:

- lint refuses those globals and any Node module in `src/`;
- `npm run typecheck` also checks the shipped source alone against ES2020 with
  no Node types (`tsconfig.lib.json`), since `@types/node` adds later methods
  such as `Array.prototype.at`, which 0.5.0 used by mistake;
- `npm run test:quickjs` bundles `quickjs/corpus.ts` as one ES2020 IIFE, the
  way Magerie bundles a script, runs it in QuickJS-ng and in a bare Node
  context, and fails unless the two results agree byte for byte. The corpus
  parses, compiles and emits every program in `corpus/`, every
  shape at its full parameter count, and the error paths. `npm test` runs it
  after vitest.

## Releasing

Push a tag `v<version>` matching `package.json`; `.github/workflows/publish.yml`
publishes through npm trusted publishing (OIDC), so no token exists anywhere.
Before the tag:

1. Note the release in `CHANGELOG.md` and bump `package.json`.
2. Prove the corpus: a program that compiled before compiles to the same bytes,
   unless the release says otherwise.
3. Run PlaySite's checks in the container, where the Play editor bundles this
   package: `node scripts/gen-sl-parser.mjs`, then `npx vitest run`, in
   `PlaySite/`. It is a private repo, so no workflow here can. When `diagnose`
   or an error's fix changed, also run `node Tools/editor-sl-smoke/editor-sl-smoke.mjs`
   from the container root, which drives the Play editor in real Monaco.
4. Run `npm run goldens -- --check` on Windows, whose WebGPU compiles through
   a different shader compiler from the Mac's that writes goldens.json. A
   compiler that rounds the library differently shows here first, and nowhere
   in CI, which has no GPU.
5. Push `main` and wait for CI, whose `consumers` job runs onejs-unity's
   and onejs-play's typecheck and tests against the commit (`consumers.yml`). `publish.yml`
   runs the same job and publishes nothing if it fails. When a consumer has to
   follow a change, land it here, fix the consumer, then re-run and tag.

The one exception to publishing by tag is the first version: npm attaches a
trusted publisher to a package that already exists, so 0.1.0 was published by
hand, and the workflow checks its tag and publishes nothing. In the OneJS
container this package is checked out at `JSModules/onejs-sl`, and
`onejs-unity` links it with `file:../onejs-sl` as a dev dependency beside its
`^` peer range.

## The one idea

**One authoring surface, one IR, several backends.** Unity cannot compile a
shader at runtime in a player build, on any graphics API, but an editor
compiles shaders at build time, so `hlsl.ts` prints HLSL for it and the build
ships the result.

So the same source draws compiled from generated HLSL in the editor and in a
native player, with no edit in between. `compile.ts` gives a host everything it
draws with. (Until 0.3.0 a VM, one fixed shader evaluating a program as data,
drew what had no shader yet; OneJS 3.8 deleted it.) `hlsl.ts` feeds OneJS's
`Editor/SLShaderGenerator.cs`. Nobody writes a manifest for it: an editor that
draws a program asks the compiled program for its
`hlsl` (a lazy getter, never read in Play), records it into
`Assets/OneJS/Recorded.sl.json`, generates the shader and
moves the live material onto it. `manifest()` is still there for an app that
would rather write its programs out at build time.

**A third and fourth backend, for the browser.** A player cannot compile a
shader, but the page it runs in can. `web.ts` prints every program as WGSL and
as GLSL ES 3.00 (carrying the library functions it calls, translated from
`lib/*.hlsl`), and OneJS's
`Plugins/WebGL/OneJSSLWeb.jslib` compiles whichever one Unity's device speaks
and draws it into the element's target. A `.sl` import carries both strings,
printed at build time; a `compile()` result has them as lazy getters, like
`hlsl`. The element draws nothing until the compiled
program is ready, and nothing after a compile error, which the page reports.
The host contract (the frame block, the
16 uniform slots, one binding pair per sampled texture) is written out at the
top of `web.ts`.

The emitters match the HLSL emitter's semantics rather than each language's
own: `%` truncates like `fmod`, `pow` takes `abs` of its base, `asin` and
`acos` clamp, `log` and `sqrt` guard their argument, a select is a
branchless `lerp`. `web.test.ts` checks the structure (every shape, every
opcode, the library order); whether the output matches the goldens is
measured in a browser, through the real element, by `Tools/sl-web-parity` in
the container.

## Two ways to write one

A `.sl` file is HLSL text and `sl.program` is a TypeScript EDSL, and they record
the same graph: a file lowers THROUGH the EDSL, so `sin(x)` and `sl.sin(x)` are
one call. `lang/` is the parser and `lang/README.md` covers it; the rest of this
file is the IR, the hash and the EDSL, which both surfaces sit on.

```hlsl
float4 main() {
    float2 p = uv * 8 + time * 0.4;
    float v = sin(p.x) + sin(p.y);
    return float4(v * 0.5 + 0.5, 0, 0, 1);
}
```

Docs lead with the file. The EDSL is the programmatic form: the IR builder, the
parser's target, and what a program built by code uses.

## Why an EDSL came first

A TypeScript EDSL inherits completion, type errors at the call site, jump to
definition, rename and the author's editor for free. Monaco in the Play editor
already has these types loaded.

It also gives common subexpression elimination for nothing, which is the most
valuable optimisation here, because **a `const` in the host language IS the
shared node**. `const p = uv.mul(8)` used three times is one node with three
references, and writing it out long hand three times costs exactly the same,
because nodes are interned as they are built.

That reasoning is why the parser, when it came, cost only a parser: it emits
this same IR, so it inherited the emitters, the hash and every test
that runs on a program.

## What is checked, and when

Everything an author can get wrong is refused **when the program is written**,
at module load, not at draw time:

| Mistake | What happens |
|---|---|
| `vec2` combined with a `vec3` | TypeScript error at the call site, and a runtime error behind it |
| `uv.z` on a two component value | "z is component 3 of a vec2, which has 2" |
| A program returning something other than a `vec4` | "a program must return a vec4. Wrap it: sl.vec4(value, 1)" |
| `vec4` given the wrong number of parts | "vec4 needs 4 components, got 3" |
| One uniform name at two widths | "declared as both a float and a vec4" |
| More than 16 uniforms or 4 textures | "this program declares 5 textures and a program may sample 4", the parser's words |
| A value borrowed from another program | "a value from another program cannot be used in this one" |

The caps are `UNIFORM_SLOTS` and `TEXTURE_SLOTS`: what OneJS binds to one
program. `compile` and `fromJSON` hold a program to them too, however it was
made.

## The hash is the fragile part

`Program.hash` is what will link a program to its compiled shader. If it differs
between the machine that generated the shader and the machine that runs it, the
player finds no shader for the program: it draws nothing and logs one error
naming the hash. Before OneJS 3.6.0 it fell back to the VM and **nobody was
told**: correct output, quietly slow, no error, the worst failure this design
could have, and the reason the hash is built the way it is.

So it is a Merkle hash over the graph reachable from the result, not a walk of
the node array. An earlier version hashed storage order, which meant hoisting a
shared subexpression into a `const` changed the hash without changing what the
program computed. Constants go through a fixed precision, so `0.1 + 0.2` and
`0.3` do not produce different shaders. It is normalised, so two ways of
writing one computation share a hash: `a + b` and `b + a` (and `*`, `dot`,
`distance`), and `8 * uv`, whose 8 is a broadcast, and `uv * 8`, whose 8 is a
float2. `min` and `max` keep their order, since which of -0 and +0 they return
depends on it. It is eight lowercase hex characters
from FNV-1a, chosen so a C# implementation can produce the same string rather
than for any cryptographic reason.

## Versions

Two numbers, with one rule: a reader accepts every version up to its own and
refuses a newer one with a message naming both.

- **`SL_HASH_VERSION`** (`ir.ts`) is bumped when the hashing scheme changes,
  which changes every hash. 2 is the normalised hash above. `toJSON` writes it
  beside the hash, and `fromJSON` checks a file's hash only when it was written
  under the same scheme and IR version, and otherwise rehashes it.

- **`SL_IR_VERSION`** (`ir.ts`) is bumped whenever an opcode, a shape or what
  one computes changes. A program carries the lowest version that has all its
  nodes (`programVersion`), and that is what its hash carries, so a bump
  rehashes only the programs using what it added: every other program keeps
  the hash its shader was recorded under. `toJSON` and `fromJSON`
  (`serial.ts`) are the IR as JSON for a host that stores programs; `fromJSON`
  checks everything an emitter relies on, refuses a newer version, and
  migrates an older one.
IR 2 came with #129. A shape takes as many parameters as it reads
(`SL_SDF_PARAMS`, six at most, and never fewer than four accepted), where it
used to take four and lose the rest. IR 3 added `SAMPLE_LOD`, and made an
SDF's shape parameters and a noise's octave count operands, where they were
immediates, so they can be any value; a constant one still prints as its
number. `fromJSON` moves an older file's immediates to operands. IR 4 added
control flow (the `if` and `loop` nodes, a loop's `param`s and each result's
`proj`) and int, uint and bool values (a node's `kind`). A program that uses
none of them is still IR 3 and keeps its hash; one with an `if` statement is
IR 4, since the statement is now a real branch rather than a select. IR 5 added
the previous frame (`SAMPLE_PREVIOUS`) and the `frame` and `deltaTime` inputs;
a program that reads none of them keeps the version and the hash it had.

## Control flow

IR 4 has it: an `if` node runs one of its two regions and gives back their
results, and a `loop` node carries its values through turns while its
condition holds. `sl.branch(cond, whenTrue, whenFalse)` and
`sl.loop(init, cond, body, max)` record them, and the text form lowers `if`,
`for`, `while`, `break`, `continue`, `switch` and a `return` anywhere onto the
two (`src/lang/lower.ts` says how: a return or break that only some ways
through reach is a flag, and what follows runs under a branch on it). No
emitter ever prints a statement that returns or breaks from inside a region;
every one prints the same structured body.

`structure.ts` decides where each node is computed: in the innermost region
every use of it is inside. A value only a branch needs is computed only when
the branch runs, one only a loop's body reads is computed each turn, and one
needed on both sides is computed once, before either. It also marks the
regions whose flow differs between neighbouring pixels, where a texture
sample has no neighbours to take its mip level from; every emitter samples
level 0 there, so every backend draws the same picture.

A `for` in the text form still unrolls when its turns are known, are 64 or
fewer, and nothing in it leaves early, and `sl.repeat(n, body, seed)` still
unrolls at record time because `n` is a JavaScript number. Everything else is
a real loop.

Every real loop has a turn limit, `max`, emitted into the loop itself: the
count a constant bound gives, the `[Range]` maximum of a uniform bound, or
1024 when the bound says neither. A loop that reaches it leaves as if its
condition had failed. That is what keeps a data dependent loop, a ray march
say, from hanging a GPU, whose reset takes the whole page's device, Unity's
included. `Tools/sl-loop-timing` in the container times a loop that breaks
early against the same maths unrolled, on each backend.

## See also

- `Specs/SHADER_LANG.md` in the OneJS container, sections 3 and 4, and section 5.4 for the Phase 0
  measurements that decided the VM's shape; the harness behind those numbers,
  `Tools/shader-vm-spike/`, is in the container's history at `afd2535`
- `onejs-unity`'s `fx`, the image pipeline this becomes a source and an operand for

## What a program is given

`uv`, `fragCoord`, `resolution`, `time` and `aspect`, and the last three are the
**target's**, not the window's. `uv` and `fragCoord` are the centre of the pixel
being drawn, so the first column's `fragCoord.x` is 0.5 on both backends.

Two more are built from those: `texel`, one pixel in uv (`1 / resolution`), and
`centered`, uv with 0 at the centre and x scaled by `aspect`, so a circle drawn
in it stays round. They are recorded only when a program names them, so every
program that does not compiles to the bytes it always did, and a program with a
`texel` of its own keeps it: a local, a parameter or a uniform of that name
shadows the input.

Three are for a program drawn frame after frame, and a host hands them over
only to a program that reads them (`readsOf`):

- `previous`, a texture: what this program drew the frame before, read as
  `tex2D(previous, uv)`. It is the program's result exactly, linear and
  straight alpha, kept at 16 bits a channel, filtered bilinear and clamped at
  the edges, with one level (so `tex2Dlod` refuses it). A read at a pixel's own
  `uv` is that pixel.
- `frame`, an int: frames drawn since `previous` was last cleared, from 0.
- `deltaTime`: seconds since the frame before, 0 on the first.

A host advances a frame when it draws with `time` moved forward: the last
result becomes `previous`, `frame` goes up by one and `deltaTime` is the step.
A draw at the same time draws the same frame again. It clears (`previous`
transparent black, `frame` and `deltaTime` 0) on the first draw, a new size, a
new program, a seek and time going back, so `frame` is 0 exactly when
`previous` is clear. A file that already used one of the three names for its
own value, texture or function keeps it.

Why `resolution` and `aspect` are the target's: a program is drawn with
`Graphics.Blit` into the element's own render texture, and Unity sets `_ScreenParams` per camera and
leaves it alone for a blit: reading it from a 64x256 target answers with the
game view's size. Both backends read the same wrong thing, so they agreed with
each other and the eject test, which compares them, saw nothing. What saw it was
a picture, because aspect correction, the one thing `aspect` exists for,
stretched every circle by the shape of whatever window it was in. The host now
sets `_Res` from the target and both backends read that.

`fx` had already learned this: `ShaderEffectElement` sets `_Aspect` from the
render texture with a comment saying why. The lesson did not travel.

## Controls

A uniform can say how a host should present it: `range` (a slider, with an
optional `step`), `toggle`, `options` (a dropdown whose value is the index),
`header`, `label` and `hide`, all on the `UniformDecl`. A `.sl` file writes them
as Unity's attributes (`[Range(0, 2)] uniform float warp = 1;`), the EDSL as the
last argument of `sl.uniform.float` and the rest. They are metadata: the hash
never reads them, so two programs that differ only in a control share one
compiled shader, and `toJSON` carries them for a host that stores a program.

The generated shader's Properties block does not carry them, and that was
measured rather than assumed (Unity 6000.5, 2026-09-27). Unity binds a material
property by the HLSL variable's type, not the Properties type: a `float4`
variable takes only `SetVector`, a `float` only `SetFloat`. Every uniform is a
`float4` set with `SetVector`, so a `Range(0, 2)` property over one draws a
slider whose default and every drag never reach the shader. A `Color` property
is worse, since `SetVector` on one converts sRGB to linear and the program
already converts a colour uniform. Carrying them means declaring a scalar
control as `float`, with a matching Properties line (`[ToggleUI]`, since
`[Toggle]` also defines a keyword; `[Enum]` as name, value pairs), and the bridge
setting it with `SetFloat`. `Specs/SL_NEXT.md` 1 keeps that as a later change.

## Colours

A hex colour is sRGB as written, the way CSS reads it, and the target holds
linear light. `sl.ramp` mixes its stops in sRGB, which is what reads as an even
ramp, and converts the result once through `TO_LINEAR`; `sl.color("#hex")` is
`parseColor` plus that conversion, and `sl.toLinear` is the conversion on its
own for a vec4 built from raw components. Both backends implement it gamma
aware (`sl_toLinear` in `lib/common.hlsl`), so a Gamma project gets the value
as written. Alpha is coverage and is never converted. Same rule as `fx`.

A ramp's stop can also be a colour value that was written as one: a colour
uniform, or a const holding a hex. The ramp takes the value from under the
conversion that reading it applied (`writtenColour` in `ir.ts`), so it blends
as written like a hex stop. A value computed in linear light has no written
form to take, so it is refused, with lerp as the way to blend it.

## Noise

`sl.noise`, `sl.simplex`, `sl.fbm(p, octaves, base)`, `sl.turbulence` and
`sl.ridged` are the fields `fx.noise` draws, from the same `lib/noise2d.hlsl`, so
a simplex here is the simplex there. Octaves are 1 to 4. A program has no seed;
offset the input for a different field. `sl.simplex` used to be value noise on
a rotated lattice, and `sl.fbm` had its own value noise; both changed on
2026-09-06 when the fields were unified.

The lattice hash under value noise and voronoi is integer arithmetic (pcg2d),
so every GPU draws the same bits: `lib/noise2d.hlsl` says why a float hash
cannot promise that. A cell is converted to an integer, so a point past
-2^31 or 2^31 lands in the edge cell, and a NaN in an undefined one. `fx.noise`
seeds are read to 1/65536: two seeds closer than that draw the same field.
