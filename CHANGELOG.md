# Changelog

## Unreleased

- `tex2Dlod(t, uv, lod)` samples a mip level; `sampleLevel` on `sl.texture`
- `BodyTarget.sampleLevel` is required, for `tex2Dlod`
- A program's IR version is the lowest that has its nodes, so IR 3 rehashes only programs that sample at a level
- `fromGLSL` turns `textureLod` into `tex2Dlod`
- A shape's parameters may be any value, a uniform included; a vector counts as its components
- `fbm`, `turbulence` and `ridged` take an octave count that is a value, rounded and held to 1 to 4

## 0.3.0

The VM is gone: every program is compiled, so there is no instruction buffer, wire version or VM limit left to import. A host on `compile` changes nothing; one still importing `onejs-sl/vm` or `onejs-sl/limits` moves to `onejs-sl/compile` and `onejs-sl/core`.

- `onejs-sl/vm`, `onejs-sl/limits`, `encode`, `forVm`, `vmFit` and `SL_WIRE_VERSION` are removed
- `VM_UNIFORMS` and `VM_TEXTURES` are removed; `UNIFORM_SLOTS` and `TEXTURE_SLOTS` in `onejs-sl/core` are the same numbers
- `MAX_TEXTURES` is removed
- `Program.loops`, `LoopSpan` and `sl.unrolled` are removed
- `fromJSON` refuses opcode 135, which only the VM's encoder wrote
- No error, doc or generated shader comment names the VM

## 0.2.1

A program built in code or read from JSON is refused past 16 uniforms or 4 textures, as a `.sl` file already was, instead of compiling and then drawing differently on different hosts. A host can read both caps.

### Fixed

- 0.2.0 regression: `compile()` dropped `encode()`'s texture check, so a program built in code with a fifth texture compiled and then sampled nothing in the editor and a native player

### Changed

- `sl.texture` and `sl.uniform` refuse past the caps where they are declared, in the parser's words
- `compile` and `fromJSON` refuse a program past either cap, however it was made
- `onejs-sl/core` exports `UNIFORM_SLOTS` (16) and `TEXTURE_SLOTS` (4), which the parser and the builder both read
- `MAX_TEXTURES` is a deprecated alias of `TEXTURE_SLOTS`, so 4 rather than 15
- `VM_UNIFORMS` and `VM_TEXTURES` are the same numbers, and go with the VM
- The parser's cap messages give OneJS's slots as the reason

## 0.2.0

`compile()` replaces `encode()` for every host that draws compiled: it gives a program's hash, names, defaults and sources with no VM buffer and no budget, so a long program or one with many values at once compiles. Program hashes do not change.

- `onejs-sl/compile` exports `compile(program)`: hash, uniforms, defaults, textures, and lazy `hlsl`, `wgsl` and `glsl`
- `compile` never refuses a program for its length or for how many values it holds at once
- `encode` is `compile` plus the VM's buffer, and still applies the VM's limits
- `onejs-sl/vm` and `onejs-sl/limits` stay until the VM is deleted
- `corpus/long.sl`, over a thousand operations, is in the goldens

## 0.1.13

Unity's Metal compile of OneJS's effects no longer warns of an uninitialized variable. Nothing draws differently.

- `onejsFbmKind` returns once, so FxSources compiles on Metal with no warning
- A WGSL noise kind no longer evaluates both fBm kinds to pick one

## 0.1.12

The noise hashes are integer arithmetic, so every GPU draws the same bits. Value noise and voronoi look different, seed 0 included; program hashes do not change.

- `noise`, `fbm`, `voronoi` and value `fx.noise` fields look different; simplex, turbulence and ridged do not
- Seeds closer than 1/65536 draw the same field, and cells past 2^31 draw the edge cell
- A 4 octave fbm costs about 14% more (3840 x 2160: 0.50 to 0.57 ms on an M4 Pro, WebGPU)
- goldens.json ships bit exact hash probes for a host's compiler, and marks exact fixtures
- `npm run goldens -- --check` compares a machine's drawing with goldens.json

## 0.1.11

The value noise hash no longer rounds differently from one GPU to the next. Seeded value noise looks different, with the same character; program hashes do not change.

- `fbm` with 2 or more octaves now looks different
- Default `fx.noise` fields now look different, since they are seeded
- `noise`, one octave of `fbm`, simplex, turbulence and ridged are unchanged
- A helper library change that keeps the IR's shape does not bump `SL_IR_VERSION`

## 0.1.10

Attributes on uniforms, for a host's controls (`Specs/SL_NEXT.md` 1). A program that has none compiles to exactly what it did, and one that has them hashes as it would without.

- `[Range]`, `[Toggle]`, `[Enum]`, `[Header]`, `[Label]`, `[Color]` and `[Hide]` before a uniform
- `UniformDecl` carries `range`, `toggle`, `options`, `header`, `label` and `hide`, never hashed
- `sl.uniform.float` and the rest take the same control as a last argument
- `sl.uniform.colour` takes components as well as a hex string
- `controlProblem` and `CONTROL_FIELDS` are exported from the core
- `ATTRIBUTE_NAMES` and `ATTRIBUTE_DOCS` are exported from `onejs-sl/tables`
- `classify` marks an attribute's name and a string

## 0.1.9

Two inputs built from the others (`Specs/SL_NEXT.md` 6), and a converter that carries more of a pasted shader over. A program that names neither input compiles to exactly what it did.

- `texel` is one pixel in uv, and `centered` is uv with 0 at the centre and x scaled by aspect
- A local, parameter or uniform named `texel` or `centered` keeps working
- A local named after a builtin can be assigned to
- `fromGLSL` reads `u_time` and `u_resolution` as the inputs, and drops their declarations
- `fromGLSL` turns a mat2 rotation into `rotate()`, and points any other mat2 at it
- `INPUT_DOCS` say `uv` and `fragCoord` are the centre of the pixel

## 0.1.8

A pasted GLSL shader becomes a `.sl` file (`Specs/SL_NEXT.md` 5). Nothing a program compiles to changes.

- `fromGLSL` converts a Shadertoy or WebGL fragment shader, with a note on everything it could not carry over
- `INPUT_DOCS` describe the output and the clock, not an element and an effect
- A body never closed is not also reported as a missing main

## 0.1.7

`diagnose` finds a mistake inside a refused call's arguments and on both sides of an operator, found by the Play editor's first run in a real browser. Nothing a program compiles to changes.

- `fract(uv * wrap)` reports both `fract` and `wrap`

## 0.1.6

`diagnose(source)` returns every error in a file, for an editor checking as it is typed (`Specs/SL_NEXT.md` 5). Nothing a program compiles to changes.

- `diagnose` finds a mistake in each statement and declaration, in source order, and never throws one
- A refused local is still declared, so its uses are not reported again

## 0.1.5

What an editor needs, and errors that fix themselves (`Specs/SL_NEXT.md` 5 and 9). Every program that compiled before compiles to exactly what it did, unless it names something after a keyword or a type.

- `classify` returns every token with its class, comments included, and never throws
- `SL_KEYWORDS`, `SL_TYPES` and `TYPE_WIDTH` are exported from `onejs-sl/tables`
- `BUILTIN_DOCS`, `INPUT_DOCS` and `PRELUDE_DOCS` describe every builtin, input and prelude function in a line
- `SLParseError` carries `text`, its message alone, and `offset`
- An error carries a one click `fix` where the fix is certain: a GLSL rename or a "did you mean"
- A GLSL name used as a value, such as `gl_FragCoord`, gets the HLSL name
- `break`, `continue` and `switch` say why they are not there
- A keyword or a type cannot name a value, a function or a parameter
- Something missing at the end of a line or the file is marked on the last token before it
- Errors from inside the EDSL say `float3`, not `vec3`
- `BodyTarget.sample` documents what the body expects of a sample

## 0.1.4

Four things that were errors now compile, the most common mistakes in cold runs of authors writing from the docs alone (`Specs/SL_NEXT.md` 2). Every program that compiled before compiles to exactly what it did.

- A swizzle can be assigned to: `p.x = 1;`, `c.rgb *= 0.5;`
- A single number fills a vector in a declaration, an assignment or a uniform default: `float3 c = 0.5;`
- A float4 goes into a float3 by dropping its fourth component: `float3 c = #ff8040;`
- A local or a uniform may take a builtin's or a prelude function's name

## 0.1.3

`onejs-sl/tables` names every parameter, so an editor can offer `lerp(x, y, s)` rather than an argument count. Nothing a program compiles to changes.

- `BUILTIN_PARAMS` names every builtin's parameters
- `SL_SDF_PARAM_NAMES` names every shape's parameters
- `LIB_SIGNATURES` gives every library function's parameter names and types

## 0.1.2

The helper library has one source, `lib/*.hlsl`, translated at build time into GLSL ES, WGSL and the shared subset and copied into OneJS as its `.cginc` files. The web draws exactly what it drew; the Unity shader's text changes where Metal needed it to, and draws the same.

- `emitLibrary` prints the library functions a body calls, in the shared subset
- `emitBody` prints no scalar swizzles, and types every literal and scalar it passes to an intrinsic
- `atan2` of vectors is refused; no web backend compiled it
- `onejs-sl/goldens.json` exports the goldens
- The tests compile the shared subset as Metal on a Mac with Xcode

## 0.1.1

A host can now supply its own frame for a program's body and get goldens for the pictures it should draw. Nothing an existing program draws changes, and OneJS's generated Unity shader is byte for byte what 0.1.0 printed.

- `onejs-sl/emit/hlsl-body`: `emitBody` and `BodyTarget`, the body in the HLSL and Metal shared subset
- The Unity shader is printed through `emitBody`
- `UniformDecl.colour` marks a uniform with a hex default, and `sl.uniform.colour` declares one
- `inputsUsed` lists the inputs a program reads
- `goldens/goldens.json`: every corpus fixture as a Linear game stores it, drawn by `npm run goldens`

## 0.1.0

The shader language compiler as its own package, moved out of `onejs-unity` with its history and its tests. It behaves exactly as `onejs-unity` 0.5.15's `sl` did, at IR version 2 and VM wire version 2.

- Entry points `onejs-sl`, `/core`, `/tables`, `/limits`, `/vm`, `/emit/unity` and `/emit/web`
- `vmFit` says whether the VM runs a program, and why not, without encoding it
- `parseColor` is exported from `onejs-sl/core`
- The test suite also runs in QuickJS-ng and must match Node byte for byte
