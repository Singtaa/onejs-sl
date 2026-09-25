/**
 * `onejs-sl/core`: a program and nothing that reads source text.
 *
 * The TypeScript form, the IR, its version and its JSON, the opcode and shape
 * tables. What a game needs at run time, which is why OneJS's `onejs-unity/sl`
 * is built on this entry and not on `onejs-sl`: the eject scaffold vendors
 * every file an entry reaches, and the parser is two thousand lines a played
 * game never executes.
 */
export * as sl from "./sl"
export type { Float, Vec2, Vec3, Vec4, Num, ProgramInputs, Texture } from "./sl"
export {
    TYPE, INPUTS, MAX_TEXTURES, MAX_NODES, SLError, hashProgram, widthName, SL_IR_VERSION,
} from "./ir"
export type {
    SLType, InputName, NodeRef, SLNode, Program, UniformDecl, TextureDecl,
} from "./ir"
export { SLOP, SL_ARITY, SL_NAME, INPUT_ID, isSampling } from "./ops"
export type { SLOpCode } from "./ops"
export { SL_SDF_SHAPES, SL_SDF_PARAMS } from "./shapes"
export type { SlSdfKind } from "./shapes"
export { toJSON, fromJSON } from "./serial"
export type { ProgramJSON } from "./serial"
export { parseColor } from "./color"
