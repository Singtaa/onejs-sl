// The hash probes: the library's two hashes read bit for bit, so a compiler
// that computes either one differently cannot pass for "close enough".
//
// Written in the library's shared subset and translated with it, so the same
// probe runs as WGSL, GLSL ES, HLSL and Metal. goldens/run.mjs draws them on
// both web backends and compares every pixel with arithmetic done in
// JavaScript; goldens.json ships each probe's text in all three languages and
// the bytes it has to draw, for a host to hold its own compiler to.
//
// A probe is a function of one pixel of a 64 x 64 frame, x and y whole numbers
// counted from the TOP left. Every pixel reads one hash value and shows three
// of its twelve highest bits, one per channel, as 0 or 1: an 8 bit target
// stores that as 0 or 255 in any colour space, so the expected bytes are exact
// and the comparison allows nothing.

/// The lowest bit of a whole number.
float slProbeBit(float v) { return v - 2.0 * floor(v * 0.5); }

/// Bits 11 - 3g, 10 - 3g and 9 - 3g of a hash value's top twelve, as r, g, b.
float4 slProbeBits(float h, int group)
{
    float v = floor(h * 4096.0);
    float t = floor(v * (group == 0 ? 0.001953125 : group == 1 ? 0.015625 : group == 2 ? 0.125 : 1.0));
    return float4(slProbeBit(floor(t * 0.25)), slProbeBit(floor(t * 0.5)), slProbeBit(t), 1.0);
}

/// Where each block of cells starts, its seed, and a sign the cell is
/// multiplied by: -1 on block 1 makes its first cell (-0, -0).
float4 slProbeCase21(int i)
{
    switch (i)
    {
    case 0: return float4(0.0, 0.0, 0.0, 1.0);
    case 1: return float4(0.0, 0.0, 0.0, -1.0);
    case 2: return float4(0.0, 0.0, -0.0, 1.0);
    case 3: return float4(0.0, 0.0, 0.5, 1.0);
    case 4: return float4(0.0, 0.0, 1.0, 1.0);
    case 5: return float4(0.0, 0.0, 19.0, 1.0);
    case 6: return float4(0.0, 0.0, 57.0, 1.0);
    case 7: return float4(0.0, 0.0, 1000000.0, 1.0);
    case 8: return float4(-4.0, -4.0, 0.0, 1.0);
    case 9: return float4(10000.0, -10000.0, 0.0, 1.0);
    case 10: return float4(1000000.0, 1000000.0, 0.0, 1.0);
    case 11: return float4(1073741824.0, -1073741824.0, 0.0, 1.0);
    case 12: return float4(3000000000.0, -3000000000.0, 0.0, 1.0);
    case 13: return float4(2147483520.0, -2147483648.0, 0.0, 1.0);
    case 14: return float4(123.0, 456.0, -3.5, 1.0);
    default: return float4(-777.0, 333.0, 57.25, 1.0);
    }
}

/// onejsHash21, the value noise hash: sixteen blocks of 64 cells, 8 x 8 from
/// the block's start, four pixels per cell.
float4 slProbeHash21(float2 pixel)
{
    float k = pixel.y * 64.0 + pixel.x;
    float block = floor(k * 0.00390625);
    float j = k - block * 256.0;
    float n = floor(j * 0.25);
    float4 c = slProbeCase21((int)block);
    float2 cell = (c.xy + float2(n - 8.0 * floor(n * 0.125), floor(n * 0.125))) * c.w;
    return slProbeBits(onejsHash21(cell, c.z), (int)(j - n * 4.0));
}

float4 slProbeCase22(int i)
{
    switch (i)
    {
    case 0: return float4(0.0, 0.0, 0.0, 1.0);
    case 1: return float4(0.0, 0.0, 0.0, -1.0);
    case 2: return float4(-4.0, -4.0, 0.0, 1.0);
    case 3: return float4(8.0, 8.0, 0.0, 1.0);
    case 4: return float4(-100.0, 50.0, 0.0, 1.0);
    case 5: return float4(1000.0, -1000.0, 0.0, 1.0);
    case 6: return float4(10000.0, -10000.0, 0.0, 1.0);
    case 7: return float4(65536.0, 65536.0, 0.0, 1.0);
    case 8: return float4(1000000.0, 1000000.0, 0.0, 1.0);
    case 9: return float4(-1000000.0, 1000000.0, 0.0, 1.0);
    case 10: return float4(16777216.0, -16777216.0, 0.0, 1.0);
    case 11: return float4(1073741824.0, -1073741824.0, 0.0, 1.0);
    case 12: return float4(2147483520.0, -2147483648.0, 0.0, 1.0);
    case 13: return float4(3000000000.0, -3000000000.0, 0.0, 1.0);
    case 14: return float4(-3000000000.0, 3000000000.0, 0.0, 1.0);
    default: return float4(123.0, 456.0, 0.0, 1.0);
    }
}

/// sl_hash22, the voronoi jitter: sixteen blocks of 32 cells, 8 x 4 from the
/// block's start, eight pixels per cell, x's bits then y's.
float4 slProbeHash22(float2 pixel)
{
    float k = pixel.y * 64.0 + pixel.x;
    float block = floor(k * 0.00390625);
    float j = k - block * 256.0;
    float n = floor(j * 0.125);
    float g = j - n * 8.0;
    float4 c = slProbeCase22((int)block);
    float2 cell = (c.xy + float2(n - 8.0 * floor(n * 0.125), floor(n * 0.125))) * c.w;
    float2 h = sl_hash22(cell);
    return slProbeBits(g < 4.0 ? h.x : h.y, (int)(g < 4.0 ? g : g - 4.0));
}
