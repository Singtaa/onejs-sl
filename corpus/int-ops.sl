// Integer arithmetic and bits, per cell, drawn as 0 or 1 per channel so two
// backends can only agree by computing the same whole numbers: truncating
// division and remainder of negatives, zero divisors, conversions past the
// int's range, wrapping, shifts past 31, and a uint hash.
float4 main() {
    int cell = int(floor(uv.x * 8)) + 8 * int(floor(uv.y * 8));
    int a = cell - 32;
    int b = (cell % 5) - 2;
    uint h = uint(cell) * 747796405u + 2891336453u;
    h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u;
    h ^= h >> 22u;
    int big = int(float(cell) * 1e9) + 2147483647;
    bool odd = (a & 1) != 0;
    bool neg = a / 3 < 0 || a % 3 < 0;
    bool mid = a >= -8 && a <= 8;
    float r = ((b == 0 ? a / 1 : a / b) | (mid ? 1 : 0)) % 2 != 0 ? 1 : 0;
    float g = ((h & 0xffu) > 127u) != odd ? 1 : 0;
    float bl = float(((big >> 31) & 1) ^ int(neg) ^ ((~cell & ((1 << (cell + 30)) >> 1)) != 0 ? 1 : 0));
    return float4(r, g, bl, 1);
}
