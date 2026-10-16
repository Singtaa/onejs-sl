// An anchor: ?: chooses one side and never blends the two, so what it does not
// choose, however large, infinite or invalid, cannot reach what it does. Each
// channel is 1 where the chosen value came through exactly, so this draws
// white. A ?: that blends computes f + (t - f) * s, which rounds 0.75 away
// beside 1e9 and is NaN beside an infinity: not white there.
//
// The conditions are comparisons written in place, which is the float choice;
// a bool local as the condition is a choice that never blended. Each value is
// both drawn (added up to 1) and compared, so a GPU that folds one reading
// still shows the other. How a blend fared, 15 Oct 2026: the 1e9 cases wrong
// in SwiftShader and right on Apple's GPU, the infinity and NaN cases wrong on
// both, on WebGL2 and WebGPU alike for an infinity and on WebGPU for NaN.
float4 main() {
    bool right = uv.x > 0.5;
    bool top = uv.y > 0.5;
    // 0 everywhere, from a value the compiler cannot fold
    float zero = floor(uv.x * 0.5);

    // Red: a ray tracer's "no hit" distance beside a hit
    float t = uv.x > 0.5 ? 0.75 : 1e9;
    float r = min(saturate(t + 0.25), right && t == 0.75 || !right && t == 1e9 ? 1 : 0);

    // Green: the same as three components
    float3 v = uv.y > 0.5 ? float3(0.1, 0.2, 0.3) : float3(1e9, -1e9, 1e9);
    float3 vSum = saturate(abs(v) + float3(0.9, 0.8, 0.7));
    bool vSame = top && v.x == 0.1 && v.y == 0.2 && v.z == 0.3 || !top && v.x == 1e9 && v.y == -1e9 && v.z == 1e9;
    float g = min(min(vSum.x, vSum.y), min(vSum.z, vSame ? 1 : 0));

    // Blue: an infinity beside the chosen value. Only the finite side is
    // checked, since a GPU need not keep an infinity it chose.
    float i = uv.x > 0.5 ? 0.25 : 1 / zero;
    float b = right ? min(saturate(i + 0.75), i == 0.25 ? 1 : 0) : 1;

    // Alpha: NaN beside the chosen value, checked the same way
    float n = uv.y > 0.5 ? zero / zero : 0.5;
    float a = top ? 1 : min(saturate(n + 0.5), n == 0.5 ? 1 : 0);

    return float4(r, g, b, a);
}
