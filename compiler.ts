/**
 * `onejs-unity/sl/compiler`: the BUILD TIME surface of the shader language.
 *
 * Everything here runs while a game is being built and nothing runs while one
 * is being played: the `.sl` parser, the encoder that turns a program into the
 * buffer the VM reads, and the manifest an editor turns into compiled shaders.
 *
 * SEPARATE FROM `onejs-unity/sl` ON PURPOSE. That barrel is what a game
 * imports, and the eject scaffold vendors it file for file into the downloaded
 * project. A parser is two thousand lines a played game never executes, so
 * re-exporting it there put it in every ejected project's source tree, where it
 * could only ever be read as clutter. The esbuild plugin and the Play worker
 * import this instead.
 */

export { analyze, parse, parseUnit, preludeFunctions, tokenize, PRELUDE_SOURCE, SLParseError } from "./lang"
export type { Checked, Expr, FuncDecl, ParseOptions, Stmt, Unit } from "./lang"
export { encode } from "./encode"
export type { Encoded } from "./encode"
export { manifest } from "./manifest"
export type { ManifestEntry, ProgramManifest } from "./manifest"
export { emitShader, emitFragmentBody, uniformProperty } from "./hlsl"
export { SL_HLSL, SL_CALL_NAMES, SL_GLSL_HINT, SL_UNIMPLEMENTED, VM_TEXTURES, VM_UNIFORMS } from "./ops"
export type { SLSurface } from "./ops"
export { BUILTINS, NOT_YET } from "./lang/builtins"
export type { Program } from "./ir"
