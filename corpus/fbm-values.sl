// An anchor: noise whose octave count is a value (IR 3) has to be the noise with
// that count written as a constant, for every count and every kind. Each
// channel is 1 wherever any pair parts by more than 1e-4, so the fixture is black.
uniform float4 counts = float4(1, 2, 3, 4);

float differs(float a, float b) { return step(1e-4, abs(a - b)); }

float4 main() {
    float2 p = uv * 5 + time * 0.3;
    float r = max(max(differs(fbm(p, counts.x), fbm(p, 1)), differs(fbm(p, counts.y), fbm(p, 2))),
                  max(differs(fbm(p, counts.z), fbm(p, 3)), differs(fbm(p, counts.w), fbm(p, 4))));
    float g = max(max(differs(turbulence(p, counts.x), turbulence(p, 1)), differs(turbulence(p, counts.y), turbulence(p, 2))),
                  max(differs(turbulence(p, counts.z), turbulence(p, 3)), differs(turbulence(p, counts.w), turbulence(p, 4))));
    float b = max(max(differs(ridged(p, counts.x), ridged(p, 1)), differs(ridged(p, counts.y), ridged(p, 2))),
                  max(differs(ridged(p, counts.z), ridged(p, 3)), differs(ridged(p, counts.w), ridged(p, 4))));
    return float4(r, g, b, 1);
}
