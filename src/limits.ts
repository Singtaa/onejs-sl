/**
 * `onejs-sl/limits`: whether a program fits the VM, without encoding it.
 *
 * The VM is the one backend with limits. A compiled backend (every web build,
 * an editor with a generated shader) runs any program; the VM runs one that is
 * at most `MAX_INSTRUCTIONS` long and never needs more than `REGISTERS`
 * values at once. OneJS refuses an over-limit program only in a build that
 * still runs the VM. A host that wants to warn an author ahead of that asks
 * here, and gets the same answer `encode` would give, because both run the
 * same checks.
 */
import { SLError, type Program } from "./ir"
import { allocate, checkBudget, forVm, reachable, wireOf } from "./encode"

export { REGISTERS, MAX_INSTRUCTIONS } from "./encode"
export { VM_UNIFORMS, VM_TEXTURES } from "./ops"

export interface VmFit {
    /** Every OneJS VM at `wire` or newer runs it. */
    fits: boolean
    /** Operations after dead code is dropped, as the VM would run them. */
    instructions: number
    /** The most values live at once, when the register file held them all. */
    registers?: number
    /** The oldest VM encoding that can run it. */
    wire: number
    /** Why it does not fit, in the words `encode` throws with. */
    reason?: string
}

export function vmFit(source: Program): VmFit {
    const program = forVm(source)
    const order = reachable(program.nodes, program.result)
    const reasons: string[] = []
    let registers: number | undefined
    const attempt = (check: () => void) => {
        try {
            check()
        } catch (e) {
            if (!(e instanceof SLError)) throw e
            reasons.push(e.message)
        }
    }
    attempt(() => checkBudget(program, order))
    attempt(() => { registers = allocate(program, order).peak })
    const fit: VmFit = { fits: reasons.length === 0, instructions: order.length, wire: wireOf(source, program) }
    if (registers !== undefined) fit.registers = registers
    if (reasons.length > 0) fit.reason = reasons.join(" ")
    return fit
}
