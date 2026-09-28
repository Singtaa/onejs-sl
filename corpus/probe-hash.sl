// The value noise hash, bit for bit, through a program. At a whole number
// point, noise is exactly the hash of that lattice cell, so each pixel reads
// one cell and shows three of the twelve highest bits of its value, as 0 or 1
// per channel. Eight blocks of 128 cells (16 x 8 from the block's start, four
// pixels per cell): around 0, around -0 and the negatives, straddling zero,
// then ever further out, past where a float still counts in ones and past
// 2^31. goldens/run.mjs compares every pixel with arithmetic, allowing
// nothing, and so should a host.
float bit(float v) { return v - 2.0 * floor(v * 0.5); }

float4 main() {
    float2 px = floor(float2(uv.x, 1.0 - uv.y) * 64.0);
    float k = px.y * 64.0 + px.x;
    float block = floor(k * 0.001953125);
    float j = k - block * 512.0;
    float n = floor(j * 0.25);
    float group = j - n * 4.0;
    float3 start = block < 0.5 ? float3(0.0, 0.0, 1.0)
        : block < 1.5 ? float3(0.0, 0.0, -1.0)
        : block < 2.5 ? float3(-8.0, -4.0, 1.0)
        : block < 3.5 ? float3(10000.0, -10000.0, 1.0)
        : block < 4.5 ? float3(1000000.0, 1000000.0, 1.0)
        : block < 5.5 ? float3(16777216.0, -16777216.0, 1.0)
        : block < 6.5 ? float3(1073741824.0, -1073741824.0, 1.0)
        : float3(3000000000.0, -3000000000.0, 1.0);
    float2 cell = (start.xy + float2(n - 16.0 * floor(n * 0.0625), floor(n * 0.0625))) * start.z;
    float v = floor(noise(cell) * 4096.0);
    float t = floor(v * (group < 0.5 ? 0.001953125 : group < 1.5 ? 0.015625 : group < 2.5 ? 0.125 : 1.0));
    return float4(bit(floor(t * 0.25)), bit(floor(t * 0.5)), bit(t), 1.0);
}
