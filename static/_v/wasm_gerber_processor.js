/* @ts-self-types="./wasm_gerber_processor.d.ts" */

/**
 * Boundary information for the entire Gerber layer
 */
export class Boundary {
    static __wrap(ptr) {
        const obj = Object.create(Boundary.prototype);
        obj.__wbg_ptr = ptr;
        BoundaryFinalization.register(obj, obj.__wbg_ptr, obj);
        return obj;
    }
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        BoundaryFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_boundary_free(ptr, 0);
    }
    /**
     * @returns {number}
     */
    get max_x() {
        const ret = wasm.boundary_max_x(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get max_y() {
        const ret = wasm.boundary_max_y(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get min_x() {
        const ret = wasm.boundary_min_x(this.__wbg_ptr);
        return ret;
    }
    /**
     * @returns {number}
     */
    get min_y() {
        const ret = wasm.boundary_min_y(this.__wbg_ptr);
        return ret;
    }
    /**
     * @param {number} min_x
     * @param {number} max_x
     * @param {number} min_y
     * @param {number} max_y
     */
    constructor(min_x, max_x, min_y, max_y) {
        const ret = wasm.boundary_new(min_x, max_x, min_y, max_y);
        this.__wbg_ptr = ret;
        BoundaryFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
}
if (Symbol.dispose) Boundary.prototype[Symbol.dispose] = Boundary.prototype.free;

/**
 * Main Gerber processor with stateful WebGL renderer
 */
export class GerberProcessor {
    __destroy_into_raw() {
        const ptr = this.__wbg_ptr;
        this.__wbg_ptr = 0;
        GerberProcessorFinalization.unregister(this);
        return ptr;
    }
    free() {
        const ptr = this.__destroy_into_raw();
        wasm.__wbg_gerberprocessor_free(ptr, 0);
    }
    /**
     * @param {Uint32Array} source_layer_ids
     * @param {Uint8Array} visible_bits
     * @param {boolean} inverted
     * @param {number} min_x
     * @param {number} max_x
     * @param {number} min_y
     * @param {number} max_y
     * @returns {number}
     */
    add_composite_layer_with_bounds(source_layer_ids, visible_bits, inverted, min_x, max_x, min_y, max_y) {
        const ptr0 = passArray32ToWasm0(source_layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(visible_bits, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_composite_layer_with_bounds(this.__wbg_ptr, ptr0, len0, ptr1, len1, inverted, min_x, max_x, min_y, max_y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {Uint32Array} source_layer_ids
     * @param {Uint8Array} visible_bits
     * @param {boolean} inverted
     * @param {number} outline_layer_id
     * @returns {number}
     */
    add_composite_layer_with_outline(source_layer_ids, visible_bits, inverted, outline_layer_id) {
        const ptr0 = passArray32ToWasm0(source_layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(visible_bits, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_composite_layer_with_outline(this.__wbg_ptr, ptr0, len0, ptr1, len1, inverted, outline_layer_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {Uint32Array} source_layer_ids
     * @param {Uint8Array} visible_bits
     * @param {boolean} inverted
     * @param {number} outline_layer_id
     * @param {string} outline_content
     * @param {number} outline_offset_x
     * @param {number} outline_offset_y
     * @returns {number}
     */
    add_composite_layer_with_outline_content(source_layer_ids, visible_bits, inverted, outline_layer_id, outline_content, outline_offset_x, outline_offset_y) {
        const ptr0 = passArray32ToWasm0(source_layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(visible_bits, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(outline_content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_composite_layer_with_outline_content(this.__wbg_ptr, ptr0, len0, ptr1, len1, inverted, outline_layer_id, ptr2, len2, outline_offset_x, outline_offset_y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {Uint32Array} source_layer_ids
     * @param {Uint8Array} visible_bits
     * @param {boolean} inverted
     * @param {number} outline_layer_id
     * @param {string} outline_content
     * @param {number} outline_offset_x
     * @param {number} outline_offset_y
     * @param {boolean} outline_preserve_arc_regions
     * @param {number} outline_arc_tessellation_quality
     * @returns {number}
     */
    add_composite_layer_with_outline_content_options(source_layer_ids, visible_bits, inverted, outline_layer_id, outline_content, outline_offset_x, outline_offset_y, outline_preserve_arc_regions, outline_arc_tessellation_quality) {
        const ptr0 = passArray32ToWasm0(source_layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(visible_bits, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passStringToWasm0(outline_content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_composite_layer_with_outline_content_options(this.__wbg_ptr, ptr0, len0, ptr1, len1, inverted, outline_layer_id, ptr2, len2, outline_offset_x, outline_offset_y, outline_preserve_arc_regions, outline_arc_tessellation_quality);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {Uint32Array} source_layer_ids
     * @param {string} preset
     * @param {boolean} inverted
     * @param {number} min_x
     * @param {number} max_x
     * @param {number} min_y
     * @param {number} max_y
     * @returns {number}
     */
    add_composite_preset_with_bounds(source_layer_ids, preset, inverted, min_x, max_x, min_y, max_y) {
        const ptr0 = passArray32ToWasm0(source_layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(preset, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_composite_preset_with_bounds(this.__wbg_ptr, ptr0, len0, ptr1, len1, inverted, min_x, max_x, min_y, max_y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {Uint32Array} source_layer_ids
     * @param {string} preset
     * @param {boolean} inverted
     * @param {number} outline_layer_id
     * @returns {number}
     */
    add_composite_preset_with_outline(source_layer_ids, preset, inverted, outline_layer_id) {
        const ptr0 = passArray32ToWasm0(source_layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(preset, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_composite_preset_with_outline(this.__wbg_ptr, ptr0, len0, ptr1, len1, inverted, outline_layer_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Add an Excellon / NC Drill file as a drill overlay.
     * @param {string} content
     * @returns {any}
     */
    add_drill_layer(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_drill_layer(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {string} content
     * @param {number} offset_x
     * @param {number} offset_y
     * @returns {any}
     */
    add_drill_layer_with_offset(content, offset_x, offset_y) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_drill_layer_with_offset(this.__wbg_ptr, ptr0, len0, offset_x, offset_y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Register worker-produced drill geometry using the same bookkeeping as a local parse.
     * @param {any} payload
     * @returns {any}
     */
    add_drill_render_payload(payload) {
        const ret = wasm.gerberprocessor_add_drill_render_payload(this.__wbg_ptr, payload);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {number} layer_id
     * @param {any} interaction_payload
     */
    add_interaction_payload(layer_id, interaction_payload) {
        const ret = wasm.gerberprocessor_add_interaction_payload(this.__wbg_ptr, layer_id, interaction_payload);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {string} target_content
     * @param {number} target_offset_x
     * @param {number} target_offset_y
     * @param {number} min_x
     * @param {number} max_x
     * @param {number} min_y
     * @param {number} max_y
     * @returns {number}
     */
    add_inverted_layer_with_bounds(target_content, target_offset_x, target_offset_y, min_x, max_x, min_y, max_y) {
        const ptr0 = passStringToWasm0(target_content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_inverted_layer_with_bounds(this.__wbg_ptr, ptr0, len0, target_offset_x, target_offset_y, min_x, max_x, min_y, max_y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {string} target_content
     * @param {number} target_offset_x
     * @param {number} target_offset_y
     * @param {boolean} target_preserve_arc_regions
     * @param {number} target_arc_tessellation_quality
     * @param {number} min_x
     * @param {number} max_x
     * @param {number} min_y
     * @param {number} max_y
     * @returns {number}
     */
    add_inverted_layer_with_bounds_options(target_content, target_offset_x, target_offset_y, target_preserve_arc_regions, target_arc_tessellation_quality, min_x, max_x, min_y, max_y) {
        const ptr0 = passStringToWasm0(target_content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_inverted_layer_with_bounds_options(this.__wbg_ptr, ptr0, len0, target_offset_x, target_offset_y, target_preserve_arc_regions, target_arc_tessellation_quality, min_x, max_x, min_y, max_y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Add an inverted display layer by filling a board outline and clearing
     * the target layer geometry from it.
     * @param {string} target_content
     * @param {string} outline_content
     * @param {number} target_offset_x
     * @param {number} target_offset_y
     * @param {number} outline_offset_x
     * @param {number} outline_offset_y
     * @returns {number}
     */
    add_inverted_layer_with_outline(target_content, outline_content, target_offset_x, target_offset_y, outline_offset_x, outline_offset_y) {
        const ptr0 = passStringToWasm0(target_content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(outline_content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_inverted_layer_with_outline(this.__wbg_ptr, ptr0, len0, ptr1, len1, target_offset_x, target_offset_y, outline_offset_x, outline_offset_y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Add an inverted display layer while preserving the parse settings of
     * independently prepared target and outline sources.
     * @param {string} target_content
     * @param {string} outline_content
     * @param {number} target_offset_x
     * @param {number} target_offset_y
     * @param {boolean} target_preserve_arc_regions
     * @param {number} target_arc_tessellation_quality
     * @param {number} outline_offset_x
     * @param {number} outline_offset_y
     * @param {boolean} outline_preserve_arc_regions
     * @param {number} outline_arc_tessellation_quality
     * @returns {number}
     */
    add_inverted_layer_with_outline_options(target_content, outline_content, target_offset_x, target_offset_y, target_preserve_arc_regions, target_arc_tessellation_quality, outline_offset_x, outline_offset_y, outline_preserve_arc_regions, outline_arc_tessellation_quality) {
        const ptr0 = passStringToWasm0(target_content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passStringToWasm0(outline_content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_inverted_layer_with_outline_options(this.__wbg_ptr, ptr0, len0, ptr1, len1, target_offset_x, target_offset_y, target_preserve_arc_regions, target_arc_tessellation_quality, outline_offset_x, outline_offset_y, outline_preserve_arc_regions, outline_arc_tessellation_quality);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Add a new layer to the renderer
     *
     * # Arguments
     * * `content` - Gerber file content as string
     *
     * # Returns
     * * Layer ID (u32) for tracking this layer
     * @param {string} content
     * @returns {number}
     */
    add_layer(content) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_layer(this.__wbg_ptr, ptr0, len0);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Add a new layer after translating its parsed geometry.
     *
     * # Arguments
     * * `content` - Gerber file content as string
     * * `offset_x` - Horizontal offset in parsed Gerber world units
     * * `offset_y` - Vertical offset in parsed Gerber world units
     *
     * # Returns
     * * Layer ID (u32) for tracking this layer
     * @param {string} content
     * @param {number} offset_x
     * @param {number} offset_y
     * @returns {number}
     */
    add_layer_with_offset(content, offset_x, offset_y) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_add_layer_with_offset(this.__wbg_ptr, ptr0, len0, offset_x, offset_y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Add a layer from geometry parsed in a worker or another WASM instance.
     * @param {any} parsed_layer
     * @returns {number}
     */
    add_parsed_layer(parsed_layer) {
        const ret = wasm.gerberprocessor_add_parsed_layer(this.__wbg_ptr, parsed_layer);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * Add a worker-produced render payload directly to WebGL buffers.
     * @param {any} render_payload
     * @returns {number}
     */
    add_render_payload(render_payload) {
        const ret = wasm.gerberprocessor_add_render_payload(this.__wbg_ptr, render_payload);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0] >>> 0;
    }
    /**
     * @param {number} composite_id
     */
    begin_composite_area_scan(composite_id) {
        const ret = wasm.gerberprocessor_begin_composite_area_scan(this.__wbg_ptr, composite_id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Build and store the interaction layer for an already-loaded render layer.
     *
     * Call this after `add_render_payload` to attach interaction data without
     * re-uploading render geometry. The gerber content is parsed a second time
     * but no GPU buffers are allocated.
     * @param {number} layer_id
     * @param {string} content
     * @param {number} offset_x
     * @param {number} offset_y
     */
    build_layer_interactions(layer_id, content, offset_x, offset_y) {
        const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_build_layer_interactions(this.__wbg_ptr, layer_id, ptr0, len0, offset_x, offset_y);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} composite_id
     */
    cancel_composite_area_scan(composite_id) {
        const ret = wasm.gerberprocessor_cancel_composite_area_scan(this.__wbg_ptr, composite_id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Clear all layers
     *
     * # Returns
     * * `"clear_done"` signal on success
     * @returns {string}
     */
    clear() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_clear(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    clear_interaction_layers() {
        wasm.gerberprocessor_clear_interaction_layers(this.__wbg_ptr);
    }
    end_composite_selection() {
        const ret = wasm.gerberprocessor_end_composite_selection(this.__wbg_ptr);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} composite_id
     * @returns {Uint32Array}
     */
    finish_composite_area_scan(composite_id) {
        const ret = wasm.gerberprocessor_finish_composite_area_scan(this.__wbg_ptr, composite_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Anti-aliasing state: `enabled`, `status` (off, pending, ready,
     * size-limited, unsupported, unexpected), whether the shared multisample
     * target and its stencil are allocated, the size a memory-limited
     * allocation failed at, the code of an unexpected GL failure, and `mode`,
     * the mode the masks were last drawn in ("multisampled" or
     * "point-sampled"), which is uniform across a frame.
     * @returns {any}
     */
    get_anti_aliasing_diagnostics() {
        const ret = wasm.gerberprocessor_get_anti_aliasing_diagnostics(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * Get the boundary of the parsed Gerber data for fitToView
     *
     * # Returns
     * * `Boundary` containing min/max x/y coordinates
     *
     * # Errors
     * * Returns error if parse() has not been called yet
     * @returns {Boundary}
     */
    get_boundary() {
        const ret = wasm.gerberprocessor_get_boundary(this.__wbg_ptr);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Boundary.__wrap(ret[0]);
    }
    /**
     * @param {number} composite_id
     * @returns {Uint32Array}
     */
    get_composite_area_codes(composite_id) {
        const ret = wasm.gerberprocessor_get_composite_area_codes(this.__wbg_ptr, composite_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {number} composite_id
     * @param {number} start_y
     * @param {number} row_count
     * @returns {Uint32Array}
     */
    get_composite_area_codes_band(composite_id, start_y, row_count) {
        const ret = wasm.gerberprocessor_get_composite_area_codes_band(this.__wbg_ptr, composite_id, start_y, row_count);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {number} composite_id
     * @returns {any}
     */
    get_composite_diagnostics(composite_id) {
        const ret = wasm.gerberprocessor_get_composite_diagnostics(this.__wbg_ptr, composite_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {number} composite_id
     * @returns {string | undefined}
     */
    get_composite_error(composite_id) {
        const ret = wasm.gerberprocessor_get_composite_error(this.__wbg_ptr, composite_id);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        let v1;
        if (ret[0] !== 0) {
            v1 = getStringFromWasm0(ret[0], ret[1]);
            wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        }
        return v1;
    }
    /**
     * Get the boundary of one parsed user layer.
     * @param {number} layer_id
     * @returns {Boundary}
     */
    get_layer_boundary(layer_id) {
        const ret = wasm.gerberprocessor_get_layer_boundary(this.__wbg_ptr, layer_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return Boundary.__wrap(ret[0]);
    }
    /**
     * Return true if an interaction layer is already stored for this layer id.
     * @param {number} layer_id
     * @returns {boolean}
     */
    has_interaction_layer(layer_id) {
        const ret = wasm.gerberprocessor_has_interaction_layer(this.__wbg_ptr, layer_id);
        return ret !== 0;
    }
    /**
     * Initialize with WebGL 2.0 context
     *
     * # Arguments
     * * `gl` - WebGL 2.0 rendering context from canvas
     *
     * # Returns
     * * `"init_done"` signal on success
     * @param {WebGL2RenderingContext} gl
     * @returns {string}
     */
    init(gl) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_init(this.__wbg_ptr, gl);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Initialize with WebGL 2.0 context and explicit framebuffer size.
     *
     * This is intended for headless contexts that do not expose an HTML canvas.
     * @param {WebGL2RenderingContext} gl
     * @param {number} width
     * @param {number} height
     * @returns {string}
     */
    init_with_size(gl, width, height) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_init_with_size(this.__wbg_ptr, gl, width, height);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Create a new GerberProcessor instance
     */
    constructor() {
        const ret = wasm.gerberprocessor_new();
        this.__wbg_ptr = ret;
        GerberProcessorFinalization.register(this, this.__wbg_ptr, this);
        return this;
    }
    /**
     * DEPRECATED: Use add_layer() instead
     * Parse Gerber file data and create renderer
     *
     * # Arguments
     * * `content` - Gerber file content as string
     *
     * # Returns
     * * `"parse_done"` signal on success
     * @param {string} content
     * @returns {string}
     */
    parse(content) {
        let deferred3_0;
        let deferred3_1;
        try {
            const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len0 = WASM_VECTOR_LEN;
            const ret = wasm.gerberprocessor_parse(this.__wbg_ptr, ptr0, len0);
            var ptr2 = ret[0];
            var len2 = ret[1];
            if (ret[3]) {
                ptr2 = 0; len2 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred3_0 = ptr2;
            deferred3_1 = len2;
            return getStringFromWasm0(ptr2, len2);
        } finally {
            wasm.__wbindgen_free(deferred3_0, deferred3_1, 1);
        }
    }
    /**
     * @param {number} composite_id
     * @param {number} x
     * @param {number} y
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @returns {number}
     */
    pick_composite_area(composite_id, x, y, zoom_x, zoom_y, offset_x, offset_y) {
        const ret = wasm.gerberprocessor_pick_composite_area(this.__wbg_ptr, composite_id, x, y, zoom_x, zoom_y, offset_x, offset_y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {number} composite_id
     * @param {number} x
     * @param {number} y
     * @returns {number}
     */
    pick_composite_code(composite_id, x, y) {
        const ret = wasm.gerberprocessor_pick_composite_code(this.__wbg_ptr, composite_id, x, y);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return ret[0];
    }
    /**
     * @param {Uint32Array} layer_ids
     * @param {number} x
     * @param {number} y
     * @param {number} tolerance
     * @returns {any}
     */
    pick_interaction_feature(layer_ids, x, y, tolerance) {
        const ptr0 = passArray32ToWasm0(layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_pick_interaction_feature(this.__wbg_ptr, ptr0, len0, x, y, tolerance);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {Uint32Array} layer_ids
     * @param {number} x
     * @param {number} y
     * @param {number} tolerance
     * @param {number} after_layer_id
     * @param {number} after_feature_id
     * @returns {any}
     */
    pick_interaction_feature_after(layer_ids, x, y, tolerance, after_layer_id, after_feature_id) {
        const ptr0 = passArray32ToWasm0(layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_pick_interaction_feature_after(this.__wbg_ptr, ptr0, len0, x, y, tolerance, after_layer_id, after_feature_id);
        if (ret[2]) {
            throw takeFromExternrefTable0(ret[1]);
        }
        return takeFromExternrefTable0(ret[0]);
    }
    /**
     * @param {number} composite_id
     */
    release_composite_cache(composite_id) {
        const ret = wasm.gerberprocessor_release_composite_cache(this.__wbg_ptr, composite_id);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Remove a layer from the renderer
     *
     * # Arguments
     * * `layer_id` - Layer ID returned from add_layer()
     *
     * # Returns
     * * `"remove_done"` signal on success
     * @param {number} layer_id
     * @returns {string}
     */
    remove_layer(layer_id) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_remove_layer(this.__wbg_ptr, layer_id);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Render geometry to FBOs and composite to canvas
     *
     * # Arguments
     * * `active_layer_ids` - Array of layer IDs to render (in order)
     * * `color_data` - Flat array of [r, g, b] or [r, g, b, a] for each active layer
     * * `zoom_x` - Horizontal zoom factor
     * * `zoom_y` - Vertical zoom factor
     * * `offset_x` - Horizontal pan offset
     * * `offset_y` - Vertical pan offset
     * * `alpha` - Global alpha for all layers
     *
     * # Returns
     * * `"render_done"` signal on success
     * @param {Uint32Array} active_layer_ids
     * @param {Float32Array} color_data
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @param {number} alpha
     * @returns {string}
     */
    render(active_layer_ids, color_data, zoom_x, zoom_y, offset_x, offset_y, alpha) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passArray32ToWasm0(active_layer_ids, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArrayF32ToWasm0(color_data, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.gerberprocessor_render(this.__wbg_ptr, ptr0, len0, ptr1, len1, zoom_x, zoom_y, offset_x, offset_y, alpha);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * @param {number} composite_id
     * @param {number} selected_code
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @returns {string}
     */
    render_composite_area_highlight(composite_id, selected_code, zoom_x, zoom_y, offset_x, offset_y) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_render_composite_area_highlight(this.__wbg_ptr, composite_id, selected_code, zoom_x, zoom_y, offset_x, offset_y);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {number} composite_id
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @returns {string}
     */
    render_composite_selection(composite_id, zoom_x, zoom_y, offset_x, offset_y) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_render_composite_selection(this.__wbg_ptr, composite_id, zoom_x, zoom_y, offset_x, offset_y);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {number} layer_id
     * @param {number} feature_id
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @returns {string}
     */
    render_interaction_highlight(layer_id, feature_id, zoom_x, zoom_y, offset_x, offset_y) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_render_interaction_highlight(this.__wbg_ptr, layer_id, feature_id, zoom_x, zoom_y, offset_x, offset_y);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Render into a fresh offscreen framebuffer and return bottom-up RGBA pixels.
     *
     * The target is always initialized to transparent black. `clear_canvas`
     * remains in the ABI for compatibility but cannot preserve contents
     * across calls because each call owns a new framebuffer.
     * @param {Uint32Array} active_layer_ids
     * @param {Float32Array} color_data
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @param {number} alpha
     * @param {boolean} clear_canvas
     * @returns {Uint8Array}
     */
    render_pixels_with_clear(active_layer_ids, color_data, zoom_x, zoom_y, offset_x, offset_y, alpha, clear_canvas) {
        const ptr0 = passArray32ToWasm0(active_layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(color_data, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_render_pixels_with_clear(this.__wbg_ptr, ptr0, len0, ptr1, len1, zoom_x, zoom_y, offset_x, offset_y, alpha, clear_canvas);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v3 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v3;
    }
    /**
     * @param {Uint32Array} active_layer_ids
     * @param {Float32Array} color_data
     * @param {Uint8Array} blend_modes
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @param {number} alpha
     * @param {boolean} clear_canvas
     * @returns {Uint8Array}
     */
    render_pixels_with_clear_and_blend_modes(active_layer_ids, color_data, blend_modes, zoom_x, zoom_y, offset_x, offset_y, alpha, clear_canvas) {
        const ptr0 = passArray32ToWasm0(active_layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArrayF32ToWasm0(color_data, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ptr2 = passArray8ToWasm0(blend_modes, wasm.__wbindgen_malloc);
        const len2 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_render_pixels_with_clear_and_blend_modes(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, zoom_x, zoom_y, offset_x, offset_y, alpha, clear_canvas);
        if (ret[3]) {
            throw takeFromExternrefTable0(ret[2]);
        }
        var v4 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
        return v4;
    }
    /**
     * Render one tile of a larger virtual canvas to the current WebGL canvas.
     *
     * The caller is expected to resize the WebGL canvas to `tile_width` x
     * `tile_height` before calling this method, then copy the result into the
     * final image at `tile_x`, `tile_y`.
     * @param {Uint32Array} active_layer_ids
     * @param {Float32Array} color_data
     * @param {number} export_width
     * @param {number} export_height
     * @param {number} tile_x
     * @param {number} tile_y
     * @param {number} tile_width
     * @param {number} tile_height
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @param {number} alpha
     * @returns {string}
     */
    render_tile(active_layer_ids, color_data, export_width, export_height, tile_x, tile_y, tile_width, tile_height, zoom_x, zoom_y, offset_x, offset_y, alpha) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passArray32ToWasm0(active_layer_ids, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArrayF32ToWasm0(color_data, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.gerberprocessor_render_tile(this.__wbg_ptr, ptr0, len0, ptr1, len1, export_width, export_height, tile_x, tile_y, tile_width, tile_height, zoom_x, zoom_y, offset_x, offset_y, alpha);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * @param {Uint32Array} active_layer_ids
     * @param {Float32Array} color_data
     * @param {Uint8Array} blend_modes
     * @param {number} export_width
     * @param {number} export_height
     * @param {number} tile_x
     * @param {number} tile_y
     * @param {number} tile_width
     * @param {number} tile_height
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @param {number} alpha
     * @returns {string}
     */
    render_tile_with_blend_modes(active_layer_ids, color_data, blend_modes, export_width, export_height, tile_x, tile_y, tile_width, tile_height, zoom_x, zoom_y, offset_x, offset_y, alpha) {
        let deferred5_0;
        let deferred5_1;
        try {
            const ptr0 = passArray32ToWasm0(active_layer_ids, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArrayF32ToWasm0(color_data, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray8ToWasm0(blend_modes, wasm.__wbindgen_malloc);
            const len2 = WASM_VECTOR_LEN;
            const ret = wasm.gerberprocessor_render_tile_with_blend_modes(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, export_width, export_height, tile_x, tile_y, tile_width, tile_height, zoom_x, zoom_y, offset_x, offset_y, alpha);
            var ptr4 = ret[0];
            var len4 = ret[1];
            if (ret[3]) {
                ptr4 = 0; len4 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred5_0 = ptr4;
            deferred5_1 = len4;
            return getStringFromWasm0(ptr4, len4);
        } finally {
            wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
        }
    }
    /**
     * Render geometry to the canvas, optionally preserving existing canvas contents.
     * @param {Uint32Array} active_layer_ids
     * @param {Float32Array} color_data
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @param {number} alpha
     * @param {boolean} clear_canvas
     * @returns {string}
     */
    render_with_clear(active_layer_ids, color_data, zoom_x, zoom_y, offset_x, offset_y, alpha, clear_canvas) {
        let deferred4_0;
        let deferred4_1;
        try {
            const ptr0 = passArray32ToWasm0(active_layer_ids, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArrayF32ToWasm0(color_data, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ret = wasm.gerberprocessor_render_with_clear(this.__wbg_ptr, ptr0, len0, ptr1, len1, zoom_x, zoom_y, offset_x, offset_y, alpha, clear_canvas);
            var ptr3 = ret[0];
            var len3 = ret[1];
            if (ret[3]) {
                ptr3 = 0; len3 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred4_0 = ptr3;
            deferred4_1 = len3;
            return getStringFromWasm0(ptr3, len3);
        } finally {
            wasm.__wbindgen_free(deferred4_0, deferred4_1, 1);
        }
    }
    /**
     * @param {Uint32Array} active_layer_ids
     * @param {Float32Array} color_data
     * @param {Uint8Array} blend_modes
     * @param {number} zoom_x
     * @param {number} zoom_y
     * @param {number} offset_x
     * @param {number} offset_y
     * @param {number} alpha
     * @param {boolean} clear_canvas
     * @returns {string}
     */
    render_with_clear_and_blend_modes(active_layer_ids, color_data, blend_modes, zoom_x, zoom_y, offset_x, offset_y, alpha, clear_canvas) {
        let deferred5_0;
        let deferred5_1;
        try {
            const ptr0 = passArray32ToWasm0(active_layer_ids, wasm.__wbindgen_malloc);
            const len0 = WASM_VECTOR_LEN;
            const ptr1 = passArrayF32ToWasm0(color_data, wasm.__wbindgen_malloc);
            const len1 = WASM_VECTOR_LEN;
            const ptr2 = passArray8ToWasm0(blend_modes, wasm.__wbindgen_malloc);
            const len2 = WASM_VECTOR_LEN;
            const ret = wasm.gerberprocessor_render_with_clear_and_blend_modes(this.__wbg_ptr, ptr0, len0, ptr1, len1, ptr2, len2, zoom_x, zoom_y, offset_x, offset_y, alpha, clear_canvas);
            var ptr4 = ret[0];
            var len4 = ret[1];
            if (ret[3]) {
                ptr4 = 0; len4 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred5_0 = ptr4;
            deferred5_1 = len4;
            return getStringFromWasm0(ptr4, len4);
        } finally {
            wasm.__wbindgen_free(deferred5_0, deferred5_1, 1);
        }
    }
    /**
     * Resize framebuffers when canvas dimensions change (e.g., fullscreen)
     *
     * # Returns
     * * `"resize_done"` signal on success
     *
     * # Errors
     * * Returns error if renderer is not initialized
     * @returns {string}
     */
    resize() {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_resize(this.__wbg_ptr);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Resize framebuffers to explicit dimensions.
     * @param {number} width
     * @param {number} height
     * @returns {string}
     */
    resize_to(width, height) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_resize_to(this.__wbg_ptr, width, height);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Recreate WebGL-owned resources after browser context restoration.
     *
     * This can recreate GPU resources only while parsed geometry is still retained.
     * After geometry has been released to reduce WASM memory, JS should rebuild
     * layers from the retained source file contents.
     * @param {WebGL2RenderingContext} gl
     * @returns {string}
     */
    restore_context(gl) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_restore_context(this.__wbg_ptr, gl);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Recreate WebGL-owned resources with an explicit framebuffer size.
     * @param {WebGL2RenderingContext} gl
     * @param {number} width
     * @param {number} height
     * @returns {string}
     */
    restore_context_with_size(gl, width, height) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_restore_context_with_size(this.__wbg_ptr, gl, width, height);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {number} composite_id
     * @param {number} start_y
     * @param {number} row_count
     */
    scan_composite_area_band(composite_id, start_y, row_count) {
        const ret = wasm.gerberprocessor_scan_composite_area_band(this.__wbg_ptr, composite_id, start_y, row_count);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Turn anti-aliased layer masks on or off (default off). Independent of
     * the minimum line width; applies to the viewer, screenshots and the
     * renderer API alike because they all go through this processor.
     * @param {boolean} enabled
     */
    set_anti_aliasing(enabled) {
        wasm.gerberprocessor_set_anti_aliasing(this.__wbg_ptr, enabled);
    }
    /**
     * Configure arc tessellation quality for legacy approximated region arcs.
     *
     * `0` = low, `1` = normal, `2` = high.
     * @param {number} arc_tessellation_quality
     */
    set_arc_tessellation_quality(arc_tessellation_quality) {
        wasm.gerberprocessor_set_arc_tessellation_quality(this.__wbg_ptr, arc_tessellation_quality);
    }
    /**
     * @param {number} composite_id
     * @param {number} min_x
     * @param {number} max_x
     * @param {number} min_y
     * @param {number} max_y
     */
    set_composite_bounds(composite_id, min_x, max_x, min_y, max_y) {
        const ret = wasm.gerberprocessor_set_composite_bounds(this.__wbg_ptr, composite_id, min_x, max_x, min_y, max_y);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} composite_id
     * @param {boolean} inverted
     */
    set_composite_inverted(composite_id, inverted) {
        const ret = wasm.gerberprocessor_set_composite_inverted(this.__wbg_ptr, composite_id, inverted);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} composite_id
     * @param {Uint8Array} visible_bits
     */
    set_composite_visible_bits(composite_id, visible_bits) {
        const ptr0 = passArray8ToWasm0(visible_bits, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_set_composite_visible_bits(this.__wbg_ptr, composite_id, ptr0, len0);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} composite_id
     * @param {number} byte_index
     * @param {number} value
     */
    set_composite_visible_byte(composite_id, byte_index, value) {
        const ret = wasm.gerberprocessor_set_composite_visible_byte(this.__wbg_ptr, composite_id, byte_index, value);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * @param {number} pixels
     */
    set_drill_outline_pixels(pixels) {
        wasm.gerberprocessor_set_drill_outline_pixels(this.__wbg_ptr, pixels);
    }
    /**
     * @param {boolean} enabled
     */
    set_interactions_enabled(enabled) {
        wasm.gerberprocessor_set_interactions_enabled(this.__wbg_ptr, enabled);
    }
    /**
     * @param {number} layer_id
     * @param {number} pixels
     * @returns {string}
     */
    set_layer_feature_extra_pixels(layer_id, pixels) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_set_layer_feature_extra_pixels(this.__wbg_ptr, layer_id, pixels);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * @param {number} layer_id
     * @param {number} pixels
     * @param {number} world
     * @returns {string}
     */
    set_layer_inner_outline(layer_id, pixels, world) {
        let deferred2_0;
        let deferred2_1;
        try {
            const ret = wasm.gerberprocessor_set_layer_inner_outline(this.__wbg_ptr, layer_id, pixels, world);
            var ptr1 = ret[0];
            var len1 = ret[1];
            if (ret[3]) {
                ptr1 = 0; len1 = 0;
                throw takeFromExternrefTable0(ret[2]);
            }
            deferred2_0 = ptr1;
            deferred2_1 = len1;
            return getStringFromWasm0(ptr1, len1);
        } finally {
            wasm.__wbindgen_free(deferred2_0, deferred2_1, 1);
        }
    }
    /**
     * Configure minimum display size for tiny rendered features.
     *
     * `0.0` disables the adjustment. Current implementation applies to
     * analytic line and arc strokes in the WebGL renderer.
     * @param {number} pixels
     */
    set_minimum_feature_pixels(pixels) {
        wasm.gerberprocessor_set_minimum_feature_pixels(this.__wbg_ptr, pixels);
    }
    /**
     * Requested mask sample count. Unsupported counts fall back to a lower
     * supported count shared by the mask and stencil formats.
     * @param {number} samples
     */
    set_msaa_samples(samples) {
        const ret = wasm.gerberprocessor_set_msaa_samples(this.__wbg_ptr, samples);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
    /**
     * Configure how regions containing arcs are parsed.
     *
     * When true, arc-containing regions are preserved for analytic WebGL rendering.
     * When false, arcs are approximated into contour points before triangulation.
     * @param {boolean} preserve_arc_regions
     */
    set_preserve_arc_regions(preserve_arc_regions) {
        wasm.gerberprocessor_set_preserve_arc_regions(this.__wbg_ptr, preserve_arc_regions);
    }
    /**
     * @param {number} composite_id
     * @param {Uint32Array} source_layer_ids
     * @param {Uint8Array} visible_bits
     */
    update_composite_sources(composite_id, source_layer_ids, visible_bits) {
        const ptr0 = passArray32ToWasm0(source_layer_ids, wasm.__wbindgen_malloc);
        const len0 = WASM_VECTOR_LEN;
        const ptr1 = passArray8ToWasm0(visible_bits, wasm.__wbindgen_malloc);
        const len1 = WASM_VECTOR_LEN;
        const ret = wasm.gerberprocessor_update_composite_sources(this.__wbg_ptr, composite_id, ptr0, len0, ptr1, len1);
        if (ret[1]) {
            throw takeFromExternrefTable0(ret[0]);
        }
    }
}
if (Symbol.dispose) GerberProcessor.prototype[Symbol.dispose] = GerberProcessor.prototype.free;

/**
 * Decompress a UNIX `compress` (`.Z`) stream, the per-file compression many
 * CAM tools apply to ODB++ `features` files. The output is capped at
 * `max_output_bytes`; the viewer charges it to the archive byte budget.
 * @param {Uint8Array} bytes
 * @param {number} max_output_bytes
 * @returns {Uint8Array}
 */
export function decompress_unix_z(bytes, max_output_bytes) {
    const ptr0 = passArray8ToWasm0(bytes, wasm.__wbindgen_malloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.decompress_unix_z(ptr0, len0, max_output_bytes);
    if (ret[3]) {
        throw takeFromExternrefTable0(ret[2]);
    }
    var v2 = getArrayU8FromWasm0(ret[0], ret[1]).slice();
    wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    return v2;
}

/**
 * Initialize panic hook for better error messages in browser console
 */
export function init_panic_hook() {
    wasm.init_panic_hook();
}

/**
 * Width of this build's linear-memory addresses in bits: 32 for the wasm32
 * package, 64 for the memory64 package.
 * @returns {number}
 */
export function memory_address_bits() {
    const ret = wasm.memory_address_bits();
    return ret >>> 0;
}

/**
 * @param {string} content
 * @param {number} offset_x
 * @param {number} offset_y
 * @returns {any}
 */
export function parse_drill_layer(content, offset_x, offset_y) {
    const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse_drill_layer(ptr0, len0, offset_x, offset_y);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Parse a drill layer in a worker, optionally including feature picking data.
 * @param {string} content
 * @param {number} offset_x
 * @param {number} offset_y
 * @param {boolean} collect_interactions
 * @returns {any}
 */
export function parse_drill_layer_payload(content, offset_x, offset_y, collect_interactions) {
    const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse_drill_layer_payload(ptr0, len0, offset_x, offset_y, collect_interactions);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {string} content
 * @param {number} offset_x
 * @param {number} offset_y
 * @returns {any}
 */
export function parse_gerber_layer(content, offset_x, offset_y) {
    const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse_gerber_layer(ptr0, len0, offset_x, offset_y);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {string} content
 * @param {number} offset_x
 * @param {number} offset_y
 * @param {boolean} preserve_arc_regions
 * @param {number} arc_tessellation_quality
 * @returns {any}
 */
export function parse_gerber_layer_payload_with_options(content, offset_x, offset_y, preserve_arc_regions, arc_tessellation_quality) {
    const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse_gerber_layer_payload_with_options(ptr0, len0, offset_x, offset_y, preserve_arc_regions, arc_tessellation_quality);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * `parse_gerber_layer_payload_with_options` that calls
 * `on_progress(stage, done, total)` while it works: `"commands"` counts the
 * bytes of the file read, `"geometry"` the parsed shapes that have become
 * render buffers, a polarity layer at a time, and `"packing"` (0 of 1) starts
 * the copy of the result into JS.
 * What the callback throws is ignored. Without `collect_interactions` the
 * result has no picking data (`interactionPayload` is null).
 * @param {string} content
 * @param {number} offset_x
 * @param {number} offset_y
 * @param {boolean} preserve_arc_regions
 * @param {number} arc_tessellation_quality
 * @param {boolean} collect_interactions
 * @param {Function} on_progress
 * @returns {any}
 */
export function parse_gerber_layer_payload_with_progress(content, offset_x, offset_y, preserve_arc_regions, arc_tessellation_quality, collect_interactions, on_progress) {
    const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse_gerber_layer_payload_with_progress(ptr0, len0, offset_x, offset_y, preserve_arc_regions, arc_tessellation_quality, collect_interactions, on_progress);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * @param {string} content
 * @param {number} offset_x
 * @param {number} offset_y
 * @param {boolean} preserve_arc_regions
 * @param {number} arc_tessellation_quality
 * @returns {any}
 */
export function parse_gerber_layer_with_options(content, offset_x, offset_y, preserve_arc_regions, arc_tessellation_quality) {
    const ptr0 = passStringToWasm0(content, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
    const len0 = WASM_VECTOR_LEN;
    const ret = wasm.parse_gerber_layer_with_options(ptr0, len0, offset_x, offset_y, preserve_arc_regions, arc_tessellation_quality);
    if (ret[2]) {
        throw takeFromExternrefTable0(ret[1]);
    }
    return takeFromExternrefTable0(ret[0]);
}

/**
 * Preflight a large JS-to-WASM input copy with catchable allocation failure.
 * @param {number} byte_count
 */
export function reserve_input_capacity(byte_count) {
    const ret = wasm.reserve_input_capacity(byte_count);
    if (ret[1]) {
        throw takeFromExternrefTable0(ret[0]);
    }
}

/**
 * Bound allocator spare capacity to the viewer's active linear-memory limit.
 * Required allocations may still grow beyond it; this is not a hard limit.
 * @param {number} page_count
 */
export function set_speculative_growth_limit_pages(page_count) {
    wasm.set_speculative_growth_limit_pages(page_count);
}

/**
 * Diagnostics of the most recent ODB++ layer parsed by this module instance
 * ("Skipped or approximated: ..."), or `undefined` when there were none.
 * Read it right after a parse or add call for an ODB++ layer envelope.
 * @returns {string | undefined}
 */
export function take_last_odb_diagnostics() {
    const ret = wasm.take_last_odb_diagnostics();
    let v1;
    if (ret[0] !== 0) {
        v1 = getStringFromWasm0(ret[0], ret[1]);
        wasm.__wbindgen_free(ret[0], ret[1] * 1, 1);
    }
    return v1;
}
function __wbg_get_imports() {
    const import0 = {
        __proto__: null,
        __wbg___wbindgen_boolean_get_5b446f51afd21013: function(arg0) {
            const v = arg0;
            const ret = typeof(v) === 'boolean' ? v : undefined;
            return isLikeNone(ret) ? 0xFFFFFF : ret ? 1 : 0;
        },
        __wbg___wbindgen_is_null_e343b7d08827ba72: function(arg0) {
            const ret = arg0 === null;
            return ret;
        },
        __wbg___wbindgen_is_string_90b56bc79aad6f6c: function(arg0) {
            const ret = typeof(arg0) === 'string';
            return ret;
        },
        __wbg___wbindgen_is_undefined_8865fb403f8fe9d8: function(arg0) {
            const ret = arg0 === undefined;
            return ret;
        },
        __wbg___wbindgen_number_get_2e0e7dee9f701a71: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'number' ? obj : undefined;
            getDataViewMemory0().setFloat64(arg0 + 8 * 1, isLikeNone(ret) ? 0 : ret, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, !isLikeNone(ret), true);
        },
        __wbg___wbindgen_string_get_0380ccaa2f57f0d9: function(arg0, arg1) {
            const obj = arg1;
            const ret = typeof(obj) === 'string' ? obj : undefined;
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg___wbindgen_throw_41e9ee4f547fc59a: function(arg0, arg1) {
            throw new Error(getStringFromWasm0(arg0, arg1));
        },
        __wbg_activeTexture_11079673eac5c921: function(arg0, arg1) {
            arg0.activeTexture(arg1 >>> 0);
        },
        __wbg_attachShader_9567ae57af6746d5: function(arg0, arg1, arg2) {
            arg0.attachShader(arg1, arg2);
        },
        __wbg_bindAttribLocation_ade0ee986a734cdf: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.bindAttribLocation(arg1, arg2 >>> 0, getStringFromWasm0(arg3, arg4));
        },
        __wbg_bindBuffer_0324f62b876c4403: function(arg0, arg1, arg2) {
            arg0.bindBuffer(arg1 >>> 0, arg2);
        },
        __wbg_bindFramebuffer_378eb18ef219d37a: function(arg0, arg1, arg2) {
            arg0.bindFramebuffer(arg1 >>> 0, arg2);
        },
        __wbg_bindRenderbuffer_e0c5aeef245a913a: function(arg0, arg1, arg2) {
            arg0.bindRenderbuffer(arg1 >>> 0, arg2);
        },
        __wbg_bindSampler_9b9743706aee71d1: function(arg0, arg1, arg2) {
            arg0.bindSampler(arg1 >>> 0, arg2);
        },
        __wbg_bindTexture_3cf008f256f3ed99: function(arg0, arg1, arg2) {
            arg0.bindTexture(arg1 >>> 0, arg2);
        },
        __wbg_bindVertexArray_f58af0a346185ec5: function(arg0, arg1) {
            arg0.bindVertexArray(arg1);
        },
        __wbg_blendEquationSeparate_fa2d4e5dde5ad8b3: function(arg0, arg1, arg2) {
            arg0.blendEquationSeparate(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_blendEquation_5fb8aee6a55cf900: function(arg0, arg1) {
            arg0.blendEquation(arg1 >>> 0);
        },
        __wbg_blendFuncSeparate_2af9d47f7efc0452: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.blendFuncSeparate(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
        },
        __wbg_blendFunc_589e4252bb396484: function(arg0, arg1, arg2) {
            arg0.blendFunc(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_blitFramebuffer_7b39bfec6cfece56: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
            arg0.blitFramebuffer(arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9 >>> 0, arg10 >>> 0);
        },
        __wbg_bufferData_5fa44d94fe7a3878: function(arg0, arg1, arg2, arg3) {
            arg0.bufferData(arg1 >>> 0, arg2, arg3 >>> 0);
        },
        __wbg_bufferData_630b8c239a9f79d5: function(arg0, arg1, arg2, arg3) {
            arg0.bufferData(arg1 >>> 0, arg2, arg3 >>> 0);
        },
        __wbg_bufferSubData_8609cd8a2c013181: function(arg0, arg1, arg2, arg3) {
            arg0.bufferSubData(arg1 >>> 0, arg2, arg3);
        },
        __wbg_byteLength_18a1704c0bf397bb: function(arg0) {
            const ret = arg0.byteLength;
            return ret;
        },
        __wbg_call_939a2607c4484b0b: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4) {
            const ret = arg0.call(arg1, arg2, arg3, arg4);
            return ret;
        }, arguments); },
        __wbg_canvas_62819c4ea69a9859: function(arg0) {
            const ret = arg0.canvas;
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_checkFramebufferStatus_301a7db105ca966b: function(arg0, arg1) {
            const ret = arg0.checkFramebufferStatus(arg1 >>> 0);
            return ret;
        },
        __wbg_clearColor_796427e8ac60fe14: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.clearColor(arg1, arg2, arg3, arg4);
        },
        __wbg_clearStencil_e4383e4a543e7997: function(arg0, arg1) {
            arg0.clearStencil(arg1);
        },
        __wbg_clear_cb96796cc568b7c8: function(arg0, arg1) {
            arg0.clear(arg1 >>> 0);
        },
        __wbg_colorMask_4d6afbbbc3022fbe: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.colorMask(arg1 !== 0, arg2 !== 0, arg3 !== 0, arg4 !== 0);
        },
        __wbg_compileShader_c2b53ff3a8851f60: function(arg0, arg1) {
            arg0.compileShader(arg1);
        },
        __wbg_createBuffer_ffe613371d42cfd3: function(arg0) {
            const ret = arg0.createBuffer();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createFramebuffer_2c6b5b0f49c88e5d: function(arg0) {
            const ret = arg0.createFramebuffer();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createProgram_cbf448e6f18a9402: function(arg0) {
            const ret = arg0.createProgram();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createRenderbuffer_c864095d6ebd60d0: function(arg0) {
            const ret = arg0.createRenderbuffer();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createShader_6c1a2295587878a5: function(arg0, arg1) {
            const ret = arg0.createShader(arg1 >>> 0);
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createTexture_5f2583508ebe379b: function(arg0) {
            const ret = arg0.createTexture();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_createVertexArray_b223ea69dd08fcab: function(arg0) {
            const ret = arg0.createVertexArray();
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_deleteBuffer_070e58aaaf2a7a8b: function(arg0, arg1) {
            arg0.deleteBuffer(arg1);
        },
        __wbg_deleteFramebuffer_3f8ab330098bf8e6: function(arg0, arg1) {
            arg0.deleteFramebuffer(arg1);
        },
        __wbg_deleteProgram_b524b30ad176cdb4: function(arg0, arg1) {
            arg0.deleteProgram(arg1);
        },
        __wbg_deleteRenderbuffer_826c9b43b7ea68f5: function(arg0, arg1) {
            arg0.deleteRenderbuffer(arg1);
        },
        __wbg_deleteShader_a70f6cc1918d67eb: function(arg0, arg1) {
            arg0.deleteShader(arg1);
        },
        __wbg_deleteTexture_9f42750adb092e4f: function(arg0, arg1) {
            arg0.deleteTexture(arg1);
        },
        __wbg_deleteVertexArray_ca9768805d051d49: function(arg0, arg1) {
            arg0.deleteVertexArray(arg1);
        },
        __wbg_disableVertexAttribArray_c4c8af1f9e4120d4: function(arg0, arg1) {
            arg0.disableVertexAttribArray(arg1 >>> 0);
        },
        __wbg_disable_19fe787eccdf0272: function(arg0, arg1) {
            arg0.disable(arg1 >>> 0);
        },
        __wbg_drawArraysInstanced_9b44aa78a087154d: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.drawArraysInstanced(arg1 >>> 0, arg2, arg3, arg4);
        },
        __wbg_drawArrays_08872e02fb57b847: function(arg0, arg1, arg2, arg3) {
            arg0.drawArrays(arg1 >>> 0, arg2, arg3);
        },
        __wbg_drawBuffers_7a58bd4729f7a1fc: function(arg0, arg1) {
            arg0.drawBuffers(arg1);
        },
        __wbg_enableVertexAttribArray_d52693866bc8b8dd: function(arg0, arg1) {
            arg0.enableVertexAttribArray(arg1 >>> 0);
        },
        __wbg_enable_cb4fc19b51148c37: function(arg0, arg1) {
            arg0.enable(arg1 >>> 0);
        },
        __wbg_error_757e9472f8410341: function(arg0, arg1) {
            let deferred0_0;
            let deferred0_1;
            try {
                deferred0_0 = arg0;
                deferred0_1 = arg1;
                console.error(getStringFromWasm0(arg0, arg1));
            } finally {
                wasm.__wbindgen_free(deferred0_0, deferred0_1, 1);
            }
        },
        __wbg_framebufferRenderbuffer_f019e9231b142c0d: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.framebufferRenderbuffer(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4);
        },
        __wbg_framebufferTexture2D_73c52f23ec33aa22: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.framebufferTexture2D(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4, arg5);
        },
        __wbg_from_296ca31f8d0f1c52: function(arg0) {
            const ret = Array.from(arg0);
            return ret;
        },
        __wbg_getError_dd9903fdd93a6802: function(arg0) {
            const ret = arg0.getError();
            return ret;
        },
        __wbg_getInternalformatParameter_3f9adb3cce445725: function() { return handleError(function (arg0, arg1, arg2, arg3) {
            const ret = arg0.getInternalformatParameter(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0);
            return ret;
        }, arguments); },
        __wbg_getParameter_974595a6624c6c10: function() { return handleError(function (arg0, arg1) {
            const ret = arg0.getParameter(arg1 >>> 0);
            return ret;
        }, arguments); },
        __wbg_getProgramInfoLog_3276b294d6d42fe2: function(arg0, arg1, arg2) {
            const ret = arg1.getProgramInfoLog(arg2);
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_getProgramParameter_fc7124bb9fb7c675: function(arg0, arg1, arg2) {
            const ret = arg0.getProgramParameter(arg1, arg2 >>> 0);
            return ret;
        },
        __wbg_getShaderInfoLog_7e0cbba353ca95da: function(arg0, arg1, arg2) {
            const ret = arg1.getShaderInfoLog(arg2);
            var ptr1 = isLikeNone(ret) ? 0 : passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            var len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_getShaderParameter_745acf10b8e45e31: function(arg0, arg1, arg2) {
            const ret = arg0.getShaderParameter(arg1, arg2 >>> 0);
            return ret;
        },
        __wbg_getUniformLocation_50ba45dade572703: function(arg0, arg1, arg2, arg3) {
            const ret = arg0.getUniformLocation(arg1, getStringFromWasm0(arg2, arg3));
            return isLikeNone(ret) ? 0 : addToExternrefTable0(ret);
        },
        __wbg_get_31af05bd4842a84f: function() { return handleError(function (arg0, arg1) {
            const ret = Reflect.get(arg0, arg1);
            return ret;
        }, arguments); },
        __wbg_get_6c896e0571ddae51: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_index_161596655339f7e1: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_index_3a25eea8c7f21379: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_get_unchecked_288889d017702237: function(arg0, arg1) {
            const ret = arg0[arg1 >>> 0];
            return ret;
        },
        __wbg_height_fc97e1a0c2e7331f: function(arg0) {
            const ret = arg0.height;
            return ret;
        },
        __wbg_instanceof_Float32Array_595afb0f28b828c9: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Float32Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_HtmlCanvasElement_0a30c11fbbf41841: function(arg0) {
            let result;
            try {
                result = arg0 instanceof HTMLCanvasElement;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Int32Array_4b9a86620726269b: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Int32Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_instanceof_Uint32Array_53a4facaf04b8a8b: function(arg0) {
            let result;
            try {
                result = arg0 instanceof Uint32Array;
            } catch (_) {
                result = false;
            }
            const ret = result;
            return ret;
        },
        __wbg_isArray_e15a2ff68ffdbef2: function(arg0) {
            const ret = Array.isArray(arg0);
            return ret;
        },
        __wbg_isContextLost_fbbab8b921e614b7: function(arg0) {
            const ret = arg0.isContextLost();
            return ret;
        },
        __wbg_isEnabled_acb9d89bd88c16bd: function(arg0, arg1) {
            const ret = arg0.isEnabled(arg1 >>> 0);
            return ret;
        },
        __wbg_length_0acba72356589f9c: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_511b1f84719d3462: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_58572db4c38f3c3e: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_length_d4bdea10311bd9cf: function(arg0) {
            const ret = arg0.length;
            return ret;
        },
        __wbg_linkProgram_acdc299c43d734a0: function(arg0, arg1) {
            arg0.linkProgram(arg1);
        },
        __wbg_new_227d7c05414eb861: function() {
            const ret = new Error();
            return ret;
        },
        __wbg_new_617a8cdb8bb1130e: function() {
            const ret = new Object();
            return ret;
        },
        __wbg_new_63c4c65d2534e5d3: function(arg0) {
            const ret = new Float32Array(arg0);
            return ret;
        },
        __wbg_new_74cd12440f4b8e4e: function(arg0) {
            const ret = new Uint32Array(arg0);
            return ret;
        },
        __wbg_new_ee2291f50781bf1d: function() {
            const ret = new Array();
            return ret;
        },
        __wbg_new_from_slice_37a3c3a194266cb8: function(arg0, arg1) {
            const ret = new Uint32Array(getArrayU32FromWasm0(arg0, arg1));
            return ret;
        },
        __wbg_new_with_length_31d0d732d07f3195: function(arg0) {
            const ret = new Uint32Array(arg0 >>> 0);
            return ret;
        },
        __wbg_new_with_length_cc0362bfe8499e5a: function(arg0) {
            const ret = new Float32Array(arg0 >>> 0);
            return ret;
        },
        __wbg_pixelStorei_cb4e43466f5b8703: function(arg0, arg1, arg2) {
            arg0.pixelStorei(arg1 >>> 0, arg2);
        },
        __wbg_prototypesetcall_06eb15da165dee8f: function(arg0, arg1, arg2) {
            Uint32Array.prototype.set.call(getArrayU32FromWasm0(arg0, arg1), arg2);
        },
        __wbg_prototypesetcall_8b03c01e2c0f8066: function(arg0, arg1, arg2) {
            Float32Array.prototype.set.call(getArrayF32FromWasm0(arg0, arg1), arg2);
        },
        __wbg_push_2baf45db356cf468: function(arg0, arg1) {
            const ret = arg0.push(arg1);
            return ret;
        },
        __wbg_readBuffer_b5d9a34a2f3d20d5: function(arg0, arg1) {
            arg0.readBuffer(arg1 >>> 0);
        },
        __wbg_readPixels_77d10183941e2936: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8) {
            arg0.readPixels(arg1, arg2, arg3, arg4, arg5 >>> 0, arg6 >>> 0, arg7 === 0 ? undefined : getArrayU8FromWasm0(arg7, arg8));
        }, arguments); },
        __wbg_renderbufferStorageMultisample_ed16f3ef446e3bc7: function(arg0, arg1, arg2, arg3, arg4, arg5) {
            arg0.renderbufferStorageMultisample(arg1 >>> 0, arg2, arg3 >>> 0, arg4, arg5);
        },
        __wbg_renderbufferStorage_52b131bbf3112b3a: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.renderbufferStorage(arg1 >>> 0, arg2 >>> 0, arg3, arg4);
        },
        __wbg_set_070bd465f1c195a4: function(arg0, arg1, arg2) {
            arg0.set(getArrayF32FromWasm0(arg1, arg2));
        },
        __wbg_set_145a351398b48c65: function() { return handleError(function (arg0, arg1, arg2) {
            const ret = Reflect.set(arg0, arg1, arg2);
            return ret;
        }, arguments); },
        __wbg_set_448fbc824992c3fd: function(arg0, arg1, arg2) {
            arg0.set(getArrayU32FromWasm0(arg1, arg2));
        },
        __wbg_shaderSource_c8812639b47d87b9: function(arg0, arg1, arg2, arg3) {
            arg0.shaderSource(arg1, getStringFromWasm0(arg2, arg3));
        },
        __wbg_stack_3b0d974bbf31e44f: function(arg0, arg1) {
            const ret = arg1.stack;
            const ptr1 = passStringToWasm0(ret, wasm.__wbindgen_malloc, wasm.__wbindgen_realloc);
            const len1 = WASM_VECTOR_LEN;
            getDataViewMemory0().setInt32(arg0 + 4 * 1, len1, true);
            getDataViewMemory0().setInt32(arg0 + 4 * 0, ptr1, true);
        },
        __wbg_stencilFuncSeparate_f168b66c597aa85f: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.stencilFuncSeparate(arg1 >>> 0, arg2 >>> 0, arg3, arg4 >>> 0);
        },
        __wbg_stencilFunc_bab7e0b7c443f093: function(arg0, arg1, arg2, arg3) {
            arg0.stencilFunc(arg1 >>> 0, arg2, arg3 >>> 0);
        },
        __wbg_stencilMaskSeparate_b30c097ea6b98504: function(arg0, arg1, arg2) {
            arg0.stencilMaskSeparate(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_stencilMask_a22be64c66abd825: function(arg0, arg1) {
            arg0.stencilMask(arg1 >>> 0);
        },
        __wbg_stencilOpSeparate_c5af5f5dbd237bea: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.stencilOpSeparate(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0, arg4 >>> 0);
        },
        __wbg_stencilOp_2697194654fee819: function(arg0, arg1, arg2, arg3) {
            arg0.stencilOp(arg1 >>> 0, arg2 >>> 0, arg3 >>> 0);
        },
        __wbg_texImage2D_151a358c7288e555: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
            arg0.texImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9 === 0 ? undefined : getArrayU8FromWasm0(arg9, arg10));
        }, arguments); },
        __wbg_texParameteri_7864076abcdb03e0: function(arg0, arg1, arg2, arg3) {
            arg0.texParameteri(arg1 >>> 0, arg2 >>> 0, arg3);
        },
        __wbg_texSubImage2D_cff3b090fb77dfe6: function() { return handleError(function (arg0, arg1, arg2, arg3, arg4, arg5, arg6, arg7, arg8, arg9, arg10) {
            arg0.texSubImage2D(arg1 >>> 0, arg2, arg3, arg4, arg5, arg6, arg7 >>> 0, arg8 >>> 0, arg9 === 0 ? undefined : getArrayU8FromWasm0(arg9, arg10));
        }, arguments); },
        __wbg_uniform1f_b5856e35a43b65a1: function(arg0, arg1, arg2) {
            arg0.uniform1f(arg1, arg2);
        },
        __wbg_uniform1i_531b98c4a7177366: function(arg0, arg1, arg2) {
            arg0.uniform1i(arg1, arg2);
        },
        __wbg_uniform1ui_353c67ec681b540c: function(arg0, arg1, arg2) {
            arg0.uniform1ui(arg1, arg2 >>> 0);
        },
        __wbg_uniform2f_a92b5bb95dc5b4d9: function(arg0, arg1, arg2, arg3) {
            arg0.uniform2f(arg1, arg2, arg3);
        },
        __wbg_uniform4fv_cf8ff646c36232c8: function(arg0, arg1, arg2, arg3) {
            arg0.uniform4fv(arg1, getArrayF32FromWasm0(arg2, arg3));
        },
        __wbg_uniformMatrix3fv_472e7824735acce1: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.uniformMatrix3fv(arg1, arg2 !== 0, getArrayF32FromWasm0(arg3, arg4));
        },
        __wbg_useProgram_e075c2902e420761: function(arg0, arg1) {
            arg0.useProgram(arg1);
        },
        __wbg_vertexAttrib1f_37ce0547e8fa5f36: function(arg0, arg1, arg2) {
            arg0.vertexAttrib1f(arg1 >>> 0, arg2);
        },
        __wbg_vertexAttribDivisor_7575d382215322f7: function(arg0, arg1, arg2) {
            arg0.vertexAttribDivisor(arg1 >>> 0, arg2 >>> 0);
        },
        __wbg_vertexAttribPointer_24b495e18df325dc: function(arg0, arg1, arg2, arg3, arg4, arg5, arg6) {
            arg0.vertexAttribPointer(arg1 >>> 0, arg2, arg3 >>> 0, arg4 !== 0, arg5, arg6);
        },
        __wbg_viewport_16936692526e2ce6: function(arg0, arg1, arg2, arg3, arg4) {
            arg0.viewport(arg1, arg2, arg3, arg4);
        },
        __wbg_width_3d0dce3d9892e35e: function(arg0) {
            const ret = arg0.width;
            return ret;
        },
        __wbindgen_generic_0000000000000001: function(arg0) {
            // Cast intrinsic for `F64 -> Externref`.
            const ret = arg0;
            return ret;
        },
        __wbindgen_generic_0000000000000002: function(arg0, arg1) {
            // Cast intrinsic for `Ref(Slice(F32)) -> NamedExternref("Float32Array")`.
            const ret = getArrayF32FromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_generic_0000000000000003: function(arg0, arg1) {
            // Cast intrinsic for `Ref(String) -> Externref`.
            const ret = getStringFromWasm0(arg0, arg1);
            return ret;
        },
        __wbindgen_init_externref_table: function() {
            const table = wasm.__wbindgen_externrefs;
            const offset = table.grow(4);
            table.set(0, undefined);
            table.set(offset + 0, undefined);
            table.set(offset + 1, null);
            table.set(offset + 2, true);
            table.set(offset + 3, false);
        },
    };
    return {
        __proto__: null,
        "./wasm_gerber_processor_bg.js": import0,
    };
}

const BoundaryFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_boundary_free(ptr, 1));
const GerberProcessorFinalization = (typeof FinalizationRegistry === 'undefined')
    ? { register: () => {}, unregister: () => {} }
    : new FinalizationRegistry(ptr => wasm.__wbg_gerberprocessor_free(ptr, 1));

function addToExternrefTable0(obj) {
    const idx = wasm.__externref_table_alloc();
    wasm.__wbindgen_externrefs.set(idx, obj);
    return idx;
}

function getArrayF32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getFloat32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU32FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint32ArrayMemory0().subarray(ptr / 4, ptr / 4 + len);
}

function getArrayU8FromWasm0(ptr, len) {
    ptr = ptr >>> 0;
    return getUint8ArrayMemory0().subarray(ptr / 1, ptr / 1 + len);
}

let cachedDataViewMemory0 = null;
function getDataViewMemory0() {
    if (cachedDataViewMemory0 === null || cachedDataViewMemory0.buffer.detached === true || (cachedDataViewMemory0.buffer.detached === undefined && cachedDataViewMemory0.buffer !== wasm.memory.buffer)) {
        cachedDataViewMemory0 = new DataView(wasm.memory.buffer);
    }
    return cachedDataViewMemory0;
}

let cachedFloat32ArrayMemory0 = null;
function getFloat32ArrayMemory0() {
    if (cachedFloat32ArrayMemory0 === null || cachedFloat32ArrayMemory0.byteLength === 0) {
        cachedFloat32ArrayMemory0 = new Float32Array(wasm.memory.buffer);
    }
    return cachedFloat32ArrayMemory0;
}

function getStringFromWasm0(ptr, len) {
    return decodeText(ptr >>> 0, len);
}

let cachedUint32ArrayMemory0 = null;
function getUint32ArrayMemory0() {
    if (cachedUint32ArrayMemory0 === null || cachedUint32ArrayMemory0.byteLength === 0) {
        cachedUint32ArrayMemory0 = new Uint32Array(wasm.memory.buffer);
    }
    return cachedUint32ArrayMemory0;
}

let cachedUint8ArrayMemory0 = null;
function getUint8ArrayMemory0() {
    if (cachedUint8ArrayMemory0 === null || cachedUint8ArrayMemory0.byteLength === 0) {
        cachedUint8ArrayMemory0 = new Uint8Array(wasm.memory.buffer);
    }
    return cachedUint8ArrayMemory0;
}

function handleError(f, args) {
    try {
        return f.apply(this, args);
    } catch (e) {
        const idx = addToExternrefTable0(e);
        wasm.__wbindgen_exn_store(idx);
    }
}

function isLikeNone(x) {
    return x === undefined || x === null;
}

function passArray32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getUint32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArray8ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 1, 1) >>> 0;
    getUint8ArrayMemory0().set(arg, ptr / 1);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passArrayF32ToWasm0(arg, malloc) {
    const ptr = malloc(arg.length * 4, 4) >>> 0;
    getFloat32ArrayMemory0().set(arg, ptr / 4);
    WASM_VECTOR_LEN = arg.length;
    return ptr;
}

function passStringToWasm0(arg, malloc, realloc) {
    if (realloc === undefined) {
        const buf = cachedTextEncoder.encode(arg);
        const ptr = malloc(buf.length, 1) >>> 0;
        getUint8ArrayMemory0().subarray(ptr, ptr + buf.length).set(buf);
        WASM_VECTOR_LEN = buf.length;
        return ptr;
    }

    let len = arg.length;
    let ptr = malloc(len, 1) >>> 0;

    const mem = getUint8ArrayMemory0();

    let offset = 0;

    for (; offset < len; offset++) {
        const code = arg.charCodeAt(offset);
        if (code > 0x7F) break;
        mem[ptr + offset] = code;
    }
    if (offset !== len) {
        if (offset !== 0) {
            arg = arg.slice(offset);
        }
        ptr = realloc(ptr, len, len = offset + arg.length * 3, 1) >>> 0;
        const view = getUint8ArrayMemory0().subarray(ptr + offset, ptr + len);
        const ret = cachedTextEncoder.encodeInto(arg, view);

        offset += ret.written;
        ptr = realloc(ptr, len, offset, 1) >>> 0;
    }

    WASM_VECTOR_LEN = offset;
    return ptr;
}

function takeFromExternrefTable0(idx) {
    const value = wasm.__wbindgen_externrefs.get(idx);
    wasm.__externref_table_dealloc(idx);
    return value;
}

let cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
cachedTextDecoder.decode();
const MAX_SAFARI_DECODE_BYTES = 2146435072;
let numBytesDecoded = 0;
function decodeText(ptr, len) {
    numBytesDecoded += len;
    if (numBytesDecoded >= MAX_SAFARI_DECODE_BYTES) {
        cachedTextDecoder = new TextDecoder('utf-8', { ignoreBOM: true, fatal: true });
        cachedTextDecoder.decode();
        numBytesDecoded = len;
    }
    return cachedTextDecoder.decode(getUint8ArrayMemory0().subarray(ptr, ptr + len));
}

const cachedTextEncoder = new TextEncoder();

if (!('encodeInto' in cachedTextEncoder)) {
    cachedTextEncoder.encodeInto = function (arg, view) {
        const buf = cachedTextEncoder.encode(arg);
        view.set(buf);
        return {
            read: arg.length,
            written: buf.length
        };
    };
}

let WASM_VECTOR_LEN = 0;

let wasmModule, wasmInstance, wasm;
function __wbg_finalize_init(instance, module) {
    wasmInstance = instance;
    wasm = instance.exports;
    wasmModule = module;
    cachedDataViewMemory0 = null;
    cachedFloat32ArrayMemory0 = null;
    cachedUint32ArrayMemory0 = null;
    cachedUint8ArrayMemory0 = null;
    wasm.__wbindgen_start();
    return wasm;
}

async function __wbg_load(module, imports) {
    if (typeof Response === 'function' && module instanceof Response) {
        if (!module.ok) {
            throw new Error(`failed to fetch Wasm: ${module.status} ${module.statusText} fetching '${module.url}'`);
        }

        if (typeof WebAssembly.instantiateStreaming === 'function') {
            try {
                return await WebAssembly.instantiateStreaming(module, imports);
            } catch (e) {
                const validResponse = expectedResponseType(module.type);

                if (validResponse && module.headers.get('Content-Type') !== 'application/wasm') {
                    console.warn("`WebAssembly.instantiateStreaming` failed because your server does not serve Wasm with `application/wasm` MIME type. Falling back to `WebAssembly.instantiate` which is slower. Original error:\n", e);

                } else { throw e; }
            }
        }

        const bytes = await module.arrayBuffer();
        return await WebAssembly.instantiate(bytes, imports);
    } else {
        const instance = await WebAssembly.instantiate(module, imports);

        if (instance instanceof WebAssembly.Instance) {
            return { instance, module };
        } else {
            return instance;
        }
    }

    function expectedResponseType(type) {
        switch (type) {
            case 'basic': case 'cors': case 'default': return true;
        }
        return false;
    }
}

function initSync(module) {
    if (wasm !== undefined) return wasm;


    if (module !== undefined) {
        if (Object.getPrototypeOf(module) === Object.prototype) {
            ({module} = module)
        } else {
            console.warn('using deprecated parameters for `initSync()`; pass a single object instead')
        }
    }

    const imports = __wbg_get_imports();
    if (!(module instanceof WebAssembly.Module)) {
        module = new WebAssembly.Module(module);
    }
    const instance = new WebAssembly.Instance(module, imports);
    return __wbg_finalize_init(instance, module);
}

async function __wbg_init(module_or_path) {
    if (wasm !== undefined) return wasm;


    if (module_or_path !== undefined) {
        if (Object.getPrototypeOf(module_or_path) === Object.prototype) {
            ({module_or_path} = module_or_path)
        } else {
            console.warn('using deprecated parameters for the initialization function; pass a single object instead')
        }
    }

    if (module_or_path === undefined) {
        module_or_path = new URL('wasm_gerber_processor_bg.wasm', import.meta.url);
    }
    const imports = __wbg_get_imports();

    if (typeof module_or_path === 'string' || (typeof Request === 'function' && module_or_path instanceof Request) || (typeof URL === 'function' && module_or_path instanceof URL)) {
        module_or_path = fetch(module_or_path);
    }

    const { instance, module } = await __wbg_load(await module_or_path, imports);

    return __wbg_finalize_init(instance, module);
}

export { initSync, __wbg_init as default };
