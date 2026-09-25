// An anchor: red is uv.x, green is uv.y, so a golden's orientation and its
// linear-to-sRGB store can be checked against arithmetic, not against itself.
float4 main() { return float4(uv.x, uv.y, 0, 1); }
