/**
 * `onejs-sl/emit/hlsl-body`: a program as a function body in the HLSL and Metal
 * shared subset, for a host that supplies its own frame (see `BodyTarget`), and
 * the library functions that body calls, in the same subset.
 */
export { emitBody, emitLibrary } from "../body"
export type { Body, BodyTarget } from "../body"
