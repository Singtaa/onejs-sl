// An anchor: the texture itself, so its orientation and its sRGB decode can be
// checked against the texture's own definition.
texture2D t;
float4 main() { return tex2D(t, uv); }
