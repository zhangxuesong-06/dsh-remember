/* SPDX-License-Identifier: MPL-2.0
 * Adapted from Gaia Sky, commit 29a096b9ef26b164cc4d0f3c9239ca567b78f4bb:
 * https://github.com/langurmonkey/gaiasky/tree/29a096b9ef26b164cc4d0f3c9239ca567b78f4bb/assets/shader
 * star.group.quad.vertex.glsl and star.group.quad.fragment.glsl.
 * License text: gaia-sky-MPL-2.0.txt in this directory (also served at /gaia-sky-MPL-2.0.txt).
 */

export const starVertexShader = /* glsl */ `
attribute vec3 starPosition;
attribute vec3 starColor;
attribute float starSize;
attribute float emphasis;
uniform vec2 viewport;
varying vec4 v_col;
varying vec2 v_uv;

void main() {
    vec4 pos = modelViewMatrix * vec4(starPosition, 1.0);
    float dist = max(length(pos.xyz), 1.0);
    // Gaia Sky's small-angle approximation, remapped to memory-scene units.
    float solidAngle = starSize / dist;
    float opacity = mix(0.18, 0.9, smoothstep(0.003, 0.022, solidAngle));
    float boundaryFade = smoothstep(8.0, 30.0, dist);
    float diameter = clamp(solidAngle * viewport.y, 3.0, 39.0);
    diameter *= mix(0.83, 1.38, clamp(emphasis - 0.1, 0.0, 1.0));
    v_col = vec4(starColor, clamp(opacity * emphasis * boundaryFade, 0.0, 1.0));
    v_uv = uv;

    // An instanced camera-facing quad, constructed in clip space with bounded screen size.
    vec4 projected = projectionMatrix * pos;
    projected.xy += position.xy * diameter * (2.0 / viewport) * projected.w;
    gl_Position = projected;
}
`

export const starFragmentShader = /* glsl */ `
varying vec4 v_col;
varying vec2 v_uv;

void main() {
    if (v_col.a <= 0.0) discard;
    float radius = distance(vec2(0.5), v_uv) * 2.0;
    // Procedural replacement for Gaia Sky's star texture.
    float profile = (0.72 * exp(-radius * radius * 29.0) + 0.28 * exp(-radius * radius * 7.2))
        * (1.0 - smoothstep(0.65, 1.0, radius));
    if (profile <= 0.0) discard;
    float alpha = v_col.a * profile;
    float core = clamp(1.0 - smoothstep(0.0, 0.19, radius), 0.0, 1.0);
    gl_FragColor = clamp(alpha * vec4(v_col.rgb + core * 1.55, 1.0), 0.0, 1.0);
}
`
