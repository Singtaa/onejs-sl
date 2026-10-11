/**
 * The Unity backend: prints a program as real HLSL, compiled at build time.
 *
 * Phase 3 of `Specs/SHADER_LANG.md` section 6. Unity cannot compile a shader
 * at runtime in a player build, so the editor generates one per program and the
 * build ships it; a browser compiles the web emitters' output instead
 * (`web.ts`). The same source draws both ways with no edit in between.
 *
 * The IR's types become the HLSL types directly, so `float2` is a `float2` and nothing needs padding or
 * explaining. One local per node also gives common subexpression elimination for
 * free: a node is emitted once no matter how many nodes reference it.
 *
 * The generated names are `n<index>` and are unreadable on purpose. Generated
 * code that looks hand written invites hand editing, and a hand edit is lost the
 * next time it is generated.
 */

import { SLError, SL_HASH_VERSION, readsOf, reachable, samplingOf, type Program, type TextureSampling } from "./ir"
import { emitBody, lit, type BodyTarget } from "./body"
import { SLOP } from "./ops"

/** The property name a uniform gets. Prefixed so it cannot collide with ours. */
export function uniformProperty(name: string): string {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
        throw new SLError(`uniform "${name}" is not a usable shader property name`)
    }
    return "_u_" + name
}

export interface EmitOptions {
    /** Shader name. Defaults to a name derived from the program hash. */
    name?: string
    /**
     * Path used for the shared helpers include. Unity resolves this relative to
     * the generated shader's own folder, so a generator writing somewhere other
     * than beside SLCommon.cginc has to say where it went.
     */
    include?: string
}

/**
 * Emits a complete `.shader` for a program.
 *
 * The shader's name carries the program hash, which is how the runtime finds it
 * again. If that link breaks, the program has no shader and draws nothing. See
 * `hashProgram`.
 */
export function emitShader(p: Program, options: EmitOptions = {}): string {
    const name = options.name ?? `Hidden/SLGenerated/${p.hash}`
    const include = options.include ?? "SLCommon.cginc"
    const body = emitFragmentBody(p)
    const reads = readsOf(p)
    const use = textureUse(p)

    const props: string[] = [
        `        _Secs ("Seconds", Float) = 0`,
        `        _FlipY ("Flip Y", Float) = 0`,
        `        _Res ("Target size", Vector) = (1, 1, 0, 0)`,
    ]
    const decls: string[] = [`            float _Secs;`, `            float _FlipY;`, `            float4 _Res;`]

    for (const u of p.uniforms) {
        const prop = uniformProperty(u.name)
        // Declared as a float4 whatever its width, so the host sets uniforms the
        // same way for every program and a widening edit does not change the
        // binding. The body swizzles down to the width the program uses.
        const d = [u.value[0] ?? 0, u.value[1] ?? 0, u.value[2] ?? 0, u.value[3] ?? 1]
        props.push(`        ${prop} ("${u.name}", Vector) = (${d.map(lit).join(", ")})`)
        decls.push(`            float4 ${prop};`)
    }
    for (const t of p.textures) {
        props.push(`        _Tex${t.slot} ("${t.name}", 2D) = "white" {}`)
        // A texture sampled as it is set is the sampler2D it always was, so
        // every program before IR 6 prints the shader it always did. One the
        // program sets a sampler for, or fetches from, is a Texture2D: the
        // inline sampler state or the Load needs the texture on its own.
        if (!use.object.has(t.slot)) decls.push(`            sampler2D _Tex${t.slot};`)
        else {
            decls.push(`            Texture2D _Tex${t.slot};`)
            // Its own settings, by Unity's naming rule, for a plain sample.
            if (use.plain.has(t.slot)) decls.push(`            SamplerState sampler_Tex${t.slot};`)
        }
        // Unity fills it from the bound texture: (1 / width, 1 / height, width, height).
        if (use.sized.has(t.slot)) decls.push(`            float4 _Tex${t.slot}_TexelSize;`)
    }
    // Unity's inline sampler states: the name says the filter and the wrap.
    for (const name of [...new Set(p.textures.map(samplingOf).filter((s) => s !== null).map(inlineSampler))].sort()) {
        decls.push(`            SamplerState ${name};`)
    }
    // Only for a program that samples it, so every other program's shader is
    // the text it always was. Transparent black is the previous frame's clear
    // value, so a host that binds nothing draws the first frame.
    if (reads.previous) {
        props.push(`        _Prev ("Previous frame", 2D) = "black" {}`)
        decls.push(`            sampler2D _Prev;`)
    }
    // What the program returns is the next frame's previous, kept at 16 bits
    // a channel, so it leaves at full precision rather than as a fixed4.
    const out = reads.previous ? "float4" : "fixed4"

    return `// GENERATED from a shader language program. Do not edit.
//
// Source of truth is the program this was emitted from; edits here are lost the
// next time it is generated. The name carries the program hash, which is how the
// runtime pairs the two. See Specs/SHADER_LANG.md section 6. The scheme that
// hash was made under, which a build compares with the apps' manifests:
// SL_HASH_VERSION ${SL_HASH_VERSION}
Shader "${name}"
{
    Properties
    {
${props.join("\n")}
    }

    SubShader
    {
        Cull Off ZWrite Off ZTest Always
        Pass
        {
            CGPROGRAM
            #pragma vertex vert
            #pragma fragment frag
            #pragma target 3.0
            #include "UnityCG.cginc"
            // Shared with the web frame, so every backend computes the same noise.
            #include "${include}"

${decls.join("\n")}

            struct appdata { float4 vertex : POSITION; float2 uv : TEXCOORD0; };
            struct v2f { float4 pos : SV_POSITION; float2 uv : TEXCOORD0; };

            v2f vert(appdata v)
            {
                v2f o;
                o.pos = UnityObjectToClipPos(v.vertex);
                // Origin corrected here, so a Unity build is not upside down
                // relative to the same program in a browser.
                o.uv = float2(v.uv.x, lerp(v.uv.y, 1.0 - v.uv.y, _FlipY));
                return o;
            }

            ${out} frag(v2f i) : SV_Target
            {
${body}
            }
            ENDCG
        }
    }
}
`
}

/**
 * The frame's side of the body: OneJS's names for the inputs, a uniform's
 * material property, and `tex2D` and `tex2Dlod` on the slot's sampler. The
 * host puts the frame count and the step in `_Res`'s spare zw, and binds the
 * previous frame as `_Prev`. `sl_toLinear` stays a
 * call because `SLCommon.cginc` decides Gamma or Linear per project, at the
 * shader compile, so this target always emits it.
 */
function unityTarget(p: Program): BodyTarget {
    const use = textureUse(p)
    return {
        // `_Res` is the TARGET's size, set by the host, not `_ScreenParams`.
        //
        // A program is drawn with Graphics.Blit into the element's own render
        // texture, and Unity leaves _ScreenParams at whatever the last camera
        // set: blitting into a 64x256 target reads it as the game view's
        // 1737x1226. So `resolution` and `fragCoord` were the window's and
        // `aspect` was the window's ratio, identically wrong on both backends,
        // which is why nothing caught it. Aspect correction, the thing `aspect`
        // exists for, stretched every circle by the shape of the window it
        // happened to be in.
        inputs: {
            uv: "i.uv",
            fragCoord: "i.uv * _Res.xy",
            resolution: "_Res.xy",
            time: "_Secs",
            aspect: "(_Res.x / max(_Res.y, 1.0))",
            frame: "_Res.z",
            deltaTime: "_Res.w",
        },
        uniform: (slot) => uniformProperty(p.uniforms[slot]!.name),
        sample: (slot, uv) => use.object.has(slot) ? `_Tex${slot}.Sample(sampler_Tex${slot}, ${uv})` : `tex2D(_Tex${slot}, ${uv})`,
        sampleLevel: (slot, uv, lod) => use.object.has(slot)
            ? `_Tex${slot}.SampleLevel(sampler_Tex${slot}, ${uv}, ${lod})`
            : `tex2Dlod(_Tex${slot}, float4(${uv}, 0.0, ${lod}))`,
        sampleWith: (slot, uv, lod, s) => lod === null
            ? `_Tex${slot}.Sample(${inlineSampler(s)}, ${uv})`
            : `_Tex${slot}.SampleLevel(${inlineSampler(s)}, ${uv}, ${lod})`,
        size: (slot) => `_Tex${slot}_TexelSize.zw`,
        fetch: (slot, pixel) => `_Tex${slot}.Load(int3(${pixel}, 0))`,
        // Flipped as this frame flipped the uv it wrote at, so a read at a
        // pixel's own uv is that pixel whichever way the host's target runs.
        previous: (uv) => `tex2Dlod(_Prev, float4(${uv} * float2(1.0, 1.0 - 2.0 * _FlipY) + float2(0.0, _FlipY), 0.0, 0.0))`,
        colour: "linear",
        indent: "                ",
        loopAttribute: "[loop]",
    }
}

/**
 * An inline sampler state's name. Unity reads the filter and the wrap from the
 * name itself ("point" or "linear", "clamp", "repeat" or "mirror").
 */
function inlineSampler(s: TextureSampling): string {
    return `sl_sampler_${s.filter}_${s.wrap}`
}

/**
 * How the program reaches each texture slot, which decides how the shader
 * declares it. `object`: declared a Texture2D, because the program sets its
 * sampler or fetches from it. `plain`: an object sampled with its own
 * settings, which needs Unity's `sampler_` state. `sized`: reads `_TexelSize`,
 * as `textureSize` and a fetch's bounds do.
 */
function textureUse(p: Program): { object: Set<number>; plain: Set<number>; sized: Set<number> } {
    const fetched = new Set<number>(), sampled = new Set<number>(), sized = new Set<number>()
    for (const ref of reachable(p.nodes, p.result)) {
        const n = p.nodes[ref]!
        if (n.k !== "call") continue
        const slot = Math.round(n.imm?.[0] ?? 0)
        if (n.op === SLOP.SAMPLE || n.op === SLOP.SAMPLE_LOD) sampled.add(slot)
        else if (n.op === SLOP.TEXTURE_SIZE) sized.add(slot)
        else if (n.op === SLOP.SAMPLE_FETCH) { fetched.add(slot); sized.add(slot) }
    }
    const object = new Set(p.textures.filter((t) => samplingOf(t) !== null || fetched.has(t.slot)).map((t) => t.slot))
    const plain = new Set([...sampled].filter((slot) => object.has(slot) && samplingOf(p.textures[slot]!) === null))
    return { object, plain, sized }
}

/** The straight line body: one local per reachable node, in order. */
export function emitFragmentBody(p: Program): string {
    return emitBody(p, unityTarget(p)).body
}
