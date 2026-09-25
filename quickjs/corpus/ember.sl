// A fire, in one file: one texture, one loop, one function.
//
// Everything a Unity shader makes you write that is not the effect is absent.
// No Properties block, no SubShader, no CGPROGRAM, no appdata or v2f, no
// _Time.y. `uniform` declares the slot AND the name React binds against, and
// `texture2D` does the same for a sampler.
//
// This program sits at exactly 8 of the VM's 8 registers, which is the real
// ceiling and not a soft one: adding another live value here is refused when
// the game is built rather than rendered wrong. That is the trade for a
// program that runs interpreted in a browser and compiled after an eject from
// the same file, with no edit in between.
texture2D smoke;

uniform float heat = 0.55;
uniform float2 source = float2(0.5, 0.08);

// Layered noise: one texture, three scales, drifting.
//
// The loop UNROLLS at build time. `i` is a number the parser substitutes, so
// both backends see straight line code and neither needs a branch, which is
// also why the bound has to be a constant. The function inlines, so calling it
// costs exactly what writing the three lines out would.
float plume(float2 p, float t) {
    float s = 0;
    for (int i = 0; i < 3; i++) {
        s = s + tex2D(smoke, p * (1 + i * 1.9) - t).r * (0.6 / (1 + i));
    }
    return s;
}

float4 main() {
    float2 p = uv - source;
    // A cone: narrow across, tall up, brightest at the source.
    float cone = saturate(1 - length(p * float2(3, 1.1)));
    float fuel = saturate(cone * (0.5 + heat) * (plume(p, time * 0.4) + 0.35));

    // Colours as written. They are mixed in sRGB and converted once, so the
    // ramp reads as evenly as its swatches do.
    return ramp(fuel, #00000000, #b53205cc, #ff8a20, #ffe7b0);
}
