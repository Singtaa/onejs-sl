// An anchor: a ramp whose stops are colour values, a colour uniform, a
// [Color] uniform and a const holding a hex, has to draw what the ramp with the
// same colours written as hexes draws. Black wherever they agree.
uniform float4 hot = #ff4000;
[Color] uniform float3 cool = float3(0, 0.5019608, 1);
const float4 mid = #80ff80;

float4 main() {
    float4 a = ramp(uv.x, hot, mid, cool, #000018);
    float4 b = ramp(uv.x, #ff4000, #80ff80, #0080ff, #000018);
    float4 d = step(1e-4, abs(a - b));
    return float4(max(d.r, d.a), d.g, d.b, 1);
}
