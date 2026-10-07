import assert from 'node:assert/strict';
import { test } from 'node:test';

import { EFFECTS_WGSL, FILTERS, fragmentShader, GHOSTING_WGSL, wgslShader } from '../src/video/filters.js';

test('every filter has both a WebGL and a WebGPU shader', () => {
    for (const filter of FILTERS) {
        assert.ok(filter.main && fragmentShader(filter).includes('void main()'), `${filter.id}: GLSL`);
        assert.ok(filter.wgsl?.includes('return'), `${filter.id}: WGSL`);
        const wgsl = wgslShader(filter);
        assert.match(wgsl, /@vertex fn vs/);
        assert.match(wgsl, /@fragment fn fs/);
        // GLSL leftovers that WGSL doesn't have.
        assert.doesNotMatch(filter.wgsl, /\b(vec[234]|ivec2|fragColor|uSrcSize|uDstSize|vUV)\b/, `${filter.id}: GLSL in WGSL`);
        if (filter.helpers) assert.ok(filter.helpersWgsl, `${filter.id}: WGSL helpers`);
    }
    for (const shader of [GHOSTING_WGSL, EFFECTS_WGSL]) assert.match(shader, /@fragment fn fs/);
});
