// A switch over an int, as the if chain it means (Specs/SL_NEXT.md 3a): one
// case per band, two labels stacked on one body, and a default.
[Range(0, 3)] uniform int mode = 2;
float4 main() {
    float t = 0;
    switch (int(uv.x * 5)) {
        case 0: t = uv.y; break;
        case 1: t = 1 - uv.y; break;
        case 2: case 3: t = length(uv - 0.5) * 1.4; break;
        default: t = frac(uv.y * 4); break;
    }
    float3 tint = float3(1, 1, 1);
    switch (mode) {
        case 0: tint = float3(1, 0.4, 0.2); break;
        case 2: tint = float3(0.2, 0.6, 1); break;
        default: break;
    }
    return float4(tint * t, 1);
}
