/**
 * `onejs-sl/vm`: the buffer OneJS's shader language VM evaluates.
 *
 * Only a host that runs the VM needs this. `SL_WIRE_VERSION` is the newest
 * encoding it writes; each result's `wire` is the oldest VM that can run it.
 */
export {
    encode, forVm, reachable, liveRanges, REGISTERS, MAX_INSTRUCTIONS, TEXELS_PER_INSTRUCTION,
} from "./encode"
export type { Encoded } from "./encode"
export { SL_WIRE_VERSION, INPUT_ID, VM_UNIFORMS, VM_TEXTURES } from "./ops"
