/**
 * `onejs-unity/sl`: write a per pixel program in TypeScript.
 *
 * Phase 1 of `Specs/SHADER_LANG.md`: the IR, the types, the EDSL and the hash.
 * Pure TypeScript with no GPU anywhere in it, which is why it is testable on its
 * own and why it lands before either backend.
 *
 * The two backends it exists to feed:
 *   - a bytecode VM, for anywhere a shader cannot be compiled at runtime, which
 *     includes every game on play.onejs.com
 *   - generated HLSL, compiled at build time, for a project that has an editor
 *
 * Same source, interpreted in the browser and compiled after an eject, with no
 * edit in between. Both backends exist: `encode.ts` feeds the VM in
 * `Runtime/SL/SLProgramBridge.cs`, and `hlsl.ts` feeds `SLShaderGenerator.cs`,
 * which an editor runs for every program it sees interpreted.
 */
export * as sl from "./sl"
export { SLOP, SL_ARITY, SL_NAME, SL_WIRE_VERSION, INPUT_ID, isSampling } from "./ops"
export { REGISTERS, MAX_INSTRUCTIONS, TEXELS_PER_INSTRUCTION, encode, reachable, liveRanges } from "./encode"
export type { Encoded } from "./encode"
export { emitShader, emitFragmentBody, uniformProperty } from "./hlsl"
export type { EmitOptions } from "./hlsl"
export { analyze, parse, parseUnit, preludeFunctions, tokenize, PRELUDE_SOURCE, SLParseError } from "./lang"
export type { Checked, Expr, FuncDecl, ParseOptions, Stmt, Unit } from "./lang"
export { SL_HLSL, SL_CALL_NAMES, SL_GLSL_HINT, SL_UNIMPLEMENTED, VM_TEXTURES, VM_UNIFORMS } from "./ops"
export type { SLSurface } from "./ops"
export { manifest } from "./manifest"
export { SL_SDF_SHAPES } from "./shapes"
export type { SlSdfKind } from "./shapes"
export type { ProgramManifest, ManifestEntry } from "./manifest"
export type { SLOpCode } from "./ops"
export {
    TYPE, INPUTS, MAX_TEXTURES, MAX_NODES, SLError, hashProgram, widthName,
} from "./ir"
export type {
    SLType, InputName, NodeRef, SLNode, Program, UniformDecl, TextureDecl,
} from "./ir"
export type { Float, Vec2, Vec3, Vec4, Num, ProgramInputs, Texture } from "./sl"
