# Changelog

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
