# onejs-sl

The OneJS shader language: a small typed language for per pixel programs. A
program is written as a `.sl` file (HLSL text) or with the TypeScript form, and
recorded as one portable IR, a flat typed graph with a hash. The package emits
that IR as the buffer OneJS's VM evaluates, a Unity ShaderLab shader, WGSL and
GLSL ES.

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
| `onejs-sl` | `parse` and `analyze`, `diagnose` (every error in a file, not just the first), `classify` (every token with its class, comments kept, never throws), the TypeScript form `sl`, the IR types, `SL_IR_VERSION`, `toJSON`/`fromJSON`, `SLParseError` (file, line, column, offset, length, the bare `text`, and a `fix` where one is certain) |
| `onejs-sl/core` | the same without the parser: what a game needs at run time |
| `onejs-sl/tables` | `BUILTINS`, `SL_HLSL`, `INPUTS`, `SL_SDF_SHAPES`, `SL_SDF_PARAMS`, `SL_KEYWORDS`, `SL_TYPES`, `TYPE_WIDTH`, `PRELUDE_NAMES`: what completion and highlighting read. `BUILTIN_PARAMS`, `SL_SDF_PARAM_NAMES` and `LIB_SIGNATURES` name every parameter, so an editor can show `lerp(x, y, s)`, and `BUILTIN_DOCS`, `INPUT_DOCS` and `PRELUDE_DOCS` give each a line for its tooltip |
| `onejs-sl/limits` | `vmFit(program)`: whether the VM runs it, and why not, without encoding |
| `onejs-sl/vm` | `encode`, `SL_WIRE_VERSION` |
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
for each input, the float4 holding a uniform slot, a texture sample, whether
`toLinear` is real (`colour: "linear"`) or the identity (`"gamma"`), and
optionally a local to assign the result to. It returns the uniform and texture
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
written, which is what a colour picker shows, and its reads convert. `inputsUsed`
says which inputs the result depends on, dead nodes aside, so a host knows
whether a program animates.

## The helper library: one source

Value and simplex noise, the octave kinds, voronoi, hsv2rgb, `toLinear` and the
42 distance shapes are written once, in HLSL, in `lib/sdf2d.hlsl`,
`lib/noise2d.hlsl` and `lib/common.hlsl`. Everything else is printed from them
by `npm run lib`, and nobody edits the copies:

- **OneJS's `.cginc` files** (`SDF2D`, `Noise2D`, `SLCommon` in
  `Resources/OneJS/`) are the source with an include guard and a generated
  header around it. The VM, the generated Unity shaders and `fx` include them.
  `npm run lib` writes them when the package sits in the OneJS container.
- **`src/lib/`**: `table.ts` (every function, its signature, what it calls, and
  the shape table read from `sl_sdfDistance`'s switch), and the text of each
  function as GLSL ES (`glsl.ts`), WGSL (`wgsl.ts`) and the shared subset
  (`hlsl.ts`). The web emitters and `emitLibrary` take only what a program calls.
  `names.ts` holds each function's parameter names, which only
  `onejs-sl/tables` reads.

`lib/translate.ts` does the printing, at build time only. It reads a subset of
HLSL, listed at its top (functions, locals, `if`, bounded `for`, `switch`,
intrinsics, `mul(v, float2x2(...))`, and one preprocessor switch,
`UNITY_COLORSPACE_GAMMA`, which becomes the target's colour), and anything
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
WebGPU and WebGL2 and draw every fixture; OneJS's parity harness holds the web
output to the VM; `SLSharedLibraryTests` draws every corpus program in Unity
through `SLCommon.cginc` and through the translated shared subset and requires
them to agree; and the Metal check above compiles the shared subset.

## Goldens

`goldens/goldens.json` is every corpus fixture drawn as a Linear OneJS game
stores it: the package's WGSL and GLSL ES in OneJS's web frame, into an
`rgba8unorm-srgb` target (the format the element's render texture has), read
back raw, with no Unity, no UI Toolkit and no browser colour management. A
second host's own backend is checked against it; OneJS's parity harness is what
proves the web emitters equal the VM in the first place.

`npm run goldens` draws it on WebGPU and WebGL2 in a Chrome with its own
profile (set `CHROME` to choose one). The two backends must agree within 1/255
over every pixel, and three anchors must match arithmetic, not each other:
`orient.sl` (orientation, and the linear to sRGB store), `hex.sl` (a hex colour
stores as written) and `texture.sl` (a texture's orientation and sRGB decode).
The whole translated library must also compile on both backends, including
the functions no fixture reaches. The file describes the sampling grid, the
times and the texture every sampled slot gets. A host imports it as
`onejs-sl/goldens.json`. No CI runner here has a GPU, so `src/goldens.test.ts` checks instead
that the file still covers the corpus at today's hashes; a change that moves a
hash fails there until the goldens are drawn again.

## Runs anywhere ES2020 runs

The source reaches for no host API: no `fs`, `process`, `Buffer`,
`TextEncoder`, `performance`, `structuredClone` or `Intl`. It runs in a
browser (the Play editor's diagnostics), a Cloudflare worker (the Play build)
and QuickJS (Magerie). Two checks hold it to that:

- lint refuses those globals and any Node module in `src/`;
- `npm run test:quickjs` bundles `quickjs/corpus.ts` as one ES2020 IIFE, the
  way Magerie bundles a script, runs it in QuickJS-ng and in a bare Node
  context, and fails unless the two results agree byte for byte. The corpus
  parses, encodes, fits and emits every program in `corpus/`, every
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
   `PlaySite/`. It is a private repo, so no workflow here can.
4. Push `main` and wait for CI, whose `consumers` job runs onejs-unity's
   typecheck and tests against the commit (`consumers.yml`). `publish.yml`
   runs the same job and publishes nothing if it fails. When a consumer has to
   follow a change, land it here, fix the consumer, then re-run and tag.

The one exception to publishing by tag is the first version: npm attaches a
trusted publisher to a package that already exists, so 0.1.0 was published by
hand, and the workflow checks its tag and publishes nothing. In the OneJS
container this package is checked out at `JSModules/onejs-sl`, and
`onejs-unity` links it with `file:../onejs-sl` as a dev dependency beside its
`^` peer range.

## The one idea

**One authoring surface, one IR, two backends.** Unity cannot compile a shader
at runtime in a player build, on any graphics API, so in the browser a program
has to become data that a fixed shader evaluates. Ejecting to a Unity project
does not change what the author wrote, it changes what is possible, because an
editor compiles shaders at build time.

So the same source is interpreted by a VM on play.onejs.com and compiled from
generated HLSL after an eject, with no edit in between. Both backends exist:
`encode.ts` feeds OneJS's `Runtime/SL/SLProgramBridge.cs` and `FxProgram.shader`,
and `hlsl.ts` feeds its `Editor/SLShaderGenerator.cs`. Nobody writes a manifest for the
second: an editor that interprets a program asks the encoded program for its
`hlsl` (a lazy getter, never read in Play), records it into
`Assets/OneJS/Recorded.sl.json`, generates the shader and
moves the live material onto it. `manifest()` is still there for an app that
would rather write its programs out at build time.

**A third and fourth backend, for the browser.** A player cannot compile a
shader, but the page it runs in can. `web.ts` prints every program as WGSL and
as GLSL ES 3.00 (carrying the library functions it calls, translated from
`lib/*.hlsl`), and OneJS's
`Plugins/WebGL/OneJSSLWeb.jslib` compiles whichever one Unity's device speaks
and draws it into the element's target in place of the VM. A `.sl` import
carries both strings, printed at build time; an `encode()` result has them as
lazy getters, like `hlsl`. The VM draws until the compiled program is ready,
and for good if it fails to compile. The host contract (the frame block, the
16 uniform slots, one binding pair per sampled texture) is written out at the
top of `web.ts`.

The emitters match the HLSL emitter's semantics rather than each language's
own: `%` truncates like `fmod`, `pow` takes `abs` of its base, `asin` and
`acos` clamp, `log` and `sqrt` guard their argument, a select is the VM's
branchless `lerp`. `web.test.ts` checks the structure (every shape, every
opcode, the library order); whether the output matches the VM within 1/255 is
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
this same IR, so it inherited the encoder, the emitter, the hash and every test
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
| More than 15 textures | Names the limit and why it cannot be widened |
| A value borrowed from another program | "a value from another program cannot be used in this one" |

The texture ceiling is the fragment shader's sampler slots on the WebGL2
baseline, which is the one resource neither backend can widen.

## The hash is the fragile part

`Program.hash` is what will link a program to its compiled shader. If it differs
between the machine that generated the shader and the machine that runs it, the
runtime falls back to the VM and **nobody is told**: correct output, quietly
slow, no error. That is the worst failure this design can have.

So it is a Merkle hash over the graph reachable from the result, not a walk of
the node array. An earlier version hashed storage order, which meant hoisting a
shared subexpression into a `const` changed the hash without changing what the
program computed. Constants go through a fixed precision, so `0.1 + 0.2` and
`0.3` do not produce different shaders. It is eight lowercase hex characters
from FNV-1a, chosen so a C# implementation can produce the same string rather
than for any cryptographic reason.

## Versions

Two numbers, with one rule: a reader accepts every version up to its own and
refuses a newer one with a message naming both.

- **`SL_IR_VERSION`** (`ir.ts`) is on every `Program` and in the hash, and is
  bumped whenever an opcode, a shape or what one computes changes. Because it
  is in the hash, a bump recompiles every cached shader. `toJSON` and
  `fromJSON` (`serial.ts`) are the IR as JSON for a host that stores programs;
  `fromJSON` checks everything an emitter relies on, refuses a newer version,
  and migrates an older one.
- **`SL_WIRE_VERSION`** (`ops.ts`) is the newest VM encoding, and
  `SLProgramBridge.WireVersion` in OneJS must match it (a container test
  compares the two). `Encoded.wire`, and the `wire` in a `.sl` import, is the
  LOWEST version that can run that program, so a program using nothing new
  stays 1 and still runs on an older Play container. The VM refuses a newer
  one, only where the VM runs; a WebGL player draws compiled and never reads
  the buffer.

IR 2 and wire 2 came with #129. A shape takes as many parameters as it reads
(`SL_SDF_PARAMS`, six at most, and never fewer than four accepted), where it
used to take four and lose the rest. One instruction holds a shape id and four
immediates, so the encoder's `forVm` turns a shape given a fifth or sixth into
`SDF_WIDE`, which reads the remaining four from a constant register. Only the
VM sees it, and only those programs are wire 2.

## Control flow

There is none in the IR, deliberately. `sl.select`, `sl.step`, `sl.smoothstep` and
`sl.mix` cover branching without branching, and `sl.repeat(n, body, seed)`
unrolls at record time because `n` is a JavaScript number.

`repeat` is honest about being a macro rather than a loop. It covers fbm,
layered noise and small iterated distance fields, which is most of what 2D
shaders loop for. A data dependent loop is out of scope: the VM would need a
nested bounded loop with a dynamic trip count while codegen would handle it
fine, and the two backends agreeing is the property the whole design protects.
Because it unrolls, the count multiplies the body's operation count toward the
VM's 256-instruction ceiling. The ceiling error names any `repeat` that fills a
quarter of the budget or more, so the fix reads as "lower this count" rather
than "fewer instructions".

Every loop that reaches a GPU is therefore bounded by a constant: `repeat` is
unrolled, fbm's octaves are a constant 1 to 4, the helper loops in the noise
and Voronoi functions have fixed trip counts. No program can hang a GPU today,
so the compiled backends carry no loop cap. A data dependent loop (the
raymarching tier) would need one emitted into every loop it prints, since a GPU
reset takes the whole page's device, Unity's included.

## See also

- `Specs/SHADER_LANG.md` in the OneJS container, sections 3 and 4, and section 5.4 for the Phase 0
  measurements that decided the VM's shape
- `Tools/shader-vm-spike/`, the harness behind those numbers
- `onejs-unity`'s `fx`, the image pipeline this becomes a source and an operand for

## What a program is given

`uv`, `fragCoord`, `resolution`, `time` and `aspect`, and the last three are the
**target's**, not the window's. A program is drawn with `Graphics.Blit` into the
element's own render texture, and Unity sets `_ScreenParams` per camera and
leaves it alone for a blit: reading it from a 64x256 target answers with the
game view's size. Both backends read the same wrong thing, so they agreed with
each other and the eject test, which compares them, saw nothing. What saw it was
a picture, because aspect correction, the one thing `aspect` exists for,
stretched every circle by the shape of whatever window it was in. The host now
sets `_Res` from the target and both backends read that.

`fx` had already learned this: `ShaderEffectElement` sets `_Aspect` from the
render texture with a comment saying why. The lesson did not travel.

## Colours

A hex colour is sRGB as written, the way CSS reads it, and the target holds
linear light. `sl.ramp` mixes its stops in sRGB, which is what reads as an even
ramp, and converts the result once through `TO_LINEAR`; `sl.color("#hex")` is
`parseColor` plus that conversion, and `sl.toLinear` is the conversion on its
own for a vec4 built from raw components. Both backends implement it gamma
aware (`sl_toLinear` in `lib/common.hlsl`), so a Gamma project gets the value
as written. Alpha is coverage and is never converted. Same rule as `fx`.

## Noise

`sl.noise`, `sl.simplex`, `sl.fbm(p, octaves, base)`, `sl.turbulence` and
`sl.ridged` are the fields `fx.noise` draws, from the same `lib/noise2d.hlsl`, so
a simplex here is the simplex there. Octaves are 1 to 4. A program has no seed;
offset the input for a different field. `sl.simplex` used to be value noise on
a rotated lattice, and `sl.fbm` had its own value noise; both changed on
2026-09-06 when the fields were unified.
