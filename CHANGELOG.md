# Changelog

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
