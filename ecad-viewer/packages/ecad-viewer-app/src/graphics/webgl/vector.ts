/*
    Copyright (c) 2022 Alethea Katherine Flowers.
    Published under the standard MIT License.
    Full text available at: https://opensource.org/licenses/MIT
*/

/**
 * Low-level library for efficiently rendering sets of basic geometric
 * primitives using WebGL. Think of it as a really hard to use version
 * of SVG. This is the underlying code used by WebGL2Renderer to actually
 * turn abstract primitives into WebGL stuff.
 *
 * The highest-level and easiest to use interface is PrimitiveSet, which
 * provides a container of mixed primitives.
 *
 * The core principle here is primitive sets. These sets collect all the data
 * necessary to render *multiple* primitives. Primitive sets are write-once.
 * Call set() with a list of primitive objects to tesselate them and upload
 * their data to the GPU. Use draw() to have the GPU render the tesselated
 * geometry. Use dispose() to free GPU resources.
 *
 */

import { Color } from "../../base/color";
import type { IDisposable } from "../../base/disposable";
import { Matrix3, Vec2 } from "../../base/math";
import { Circle, Polygon, Polyline } from "../shapes";
import { triangulate } from "./triangulate";
import { Buffer, ShaderProgram, VertexArray } from "./helpers";
import polygon_frag_shader_src from "./polygon.frag.glsl";
import polygon_vert_shader_src from "./polygon.vert.glsl";
import polyline_frag_shader_src from "./polyline.frag.glsl";
import polyline_vert_shader_src from "./polyline.vert.glsl";

/**
 * Tesselator handles converting abstract primitives into triangles that
 * can be passed to the GPU and shaded.
 */
class Tesselator {
    // Each line segment or circle is a two-triangle quad.
    static vertices_per_quad = 2 * 3;

    /**
     * Convert a quad to two triangles that cover the same area
     * @param quad four points defining the quad
     * @returns six points representing two triangles
     */
    static quad_to_triangles(quad: [Vec2, Vec2, Vec2, Vec2]): number[] {
        const positions = [
            ...quad[0],
            ...quad[2],
            ...quad[1],
            ...quad[1],
            ...quad[2],
            ...quad[3],
        ];

        // check for degenerate quads
        // TODO: this can eventually be removed.
        if (positions.filter((v) => Number.isNaN(v)).length) {
            throw new Error("Degenerate quad");
        }

        return positions;
    }

    /**
     * Write a quad's two triangles directly into `dest` at `offset` (12
     * floats), without allocating. Same vertex order as quad_to_triangles.
     */
    static write_quad_triangles(
        dest: Float32Array,
        offset: number,
        quad: [Vec2, Vec2, Vec2, Vec2],
    ) {
        const a = quad[0] as Vec2;
        const b = quad[1] as Vec2;
        const c = quad[2] as Vec2;
        const d = quad[3] as Vec2;

        dest[offset] = a.x;
        dest[offset + 1] = a.y;
        dest[offset + 2] = c.x;
        dest[offset + 3] = c.y;
        dest[offset + 4] = b.x;
        dest[offset + 5] = b.y;
        dest[offset + 6] = b.x;
        dest[offset + 7] = b.y;
        dest[offset + 8] = c.x;
        dest[offset + 9] = c.y;
        dest[offset + 10] = d.x;
        dest[offset + 11] = d.y;
    }

    /**
     * Tesselate one polyline straight into the aggregate buffers that
     * PolylineSet uploads. The per-segment quads here are computed in scalars
     * on purpose: this runs tens of thousands of times per label repaint, and
     * the Vec2-building version of tesselate_segment was the hottest function
     * in the zoom profile. Returns the number of vertices written.
     */
    static write_polyline(
        position_data: Float32Array,
        position_idx: number,
        cap_data: Float32Array,
        cap_idx: number,
        color_data: Float32Array,
        color_idx: number,
        polyline: Polyline,
    ): number {
        const width = polyline.width || 0;
        const w2 = width / 2;
        const points = polyline.points;
        const color = polyline.color ? polyline.color.to_array() : [1, 0, 0, 1];
        const cr = color[0]!;
        const cg = color[1]!;
        const cb = color[2]!;
        const ca = color[3]!;
        let vertices = 0;

        for (let i = 1; i < points.length; i++) {
            const p1 = points[i - 1]!;
            const p2 = points[i]!;
            const dx = p2.x - p1.x;
            const dy = p2.y - p1.y;
            const length = Math.sqrt(dx * dx + dy * dy);

            // skip zero-length segments
            if (length == 0) {
                continue;
            }

            // Inlined tesselate_segment for a segment of width `width`.
            const ux = -dy / length;
            const uy = dx / length;
            const nx = ux * w2;
            const ny = uy * w2;
            const n2x = -ny;
            const n2y = nx;

            const ax = p1.x + nx + n2x;
            const ay = p1.y + ny + n2y;
            const bx = p1.x - nx + n2x;
            const by = p1.y - ny + n2y;
            const cx = p2.x + nx - n2x;
            const cy = p2.y + ny - n2y;
            const ex = p2.x - nx - n2x;
            const ey = p2.y - ny - n2y;

            // a, c, b, b, c, e as one triangle pair.
            position_data[position_idx] = ax;
            position_data[position_idx + 1] = ay;
            position_data[position_idx + 2] = cx;
            position_data[position_idx + 3] = cy;
            position_data[position_idx + 4] = bx;
            position_data[position_idx + 5] = by;
            position_data[position_idx + 6] = bx;
            position_data[position_idx + 7] = by;
            position_data[position_idx + 8] = cx;
            position_data[position_idx + 9] = cy;
            position_data[position_idx + 10] = ex;
            position_data[position_idx + 11] = ey;
            position_idx += 12;

            const cap = width / (length + width);
            cap_data[cap_idx] = cap;
            cap_data[cap_idx + 1] = cap;
            cap_data[cap_idx + 2] = cap;
            cap_data[cap_idx + 3] = cap;
            cap_data[cap_idx + 4] = cap;
            cap_data[cap_idx + 5] = cap;
            cap_idx += 6;

            const color_end = color_idx + 24;
            for (; color_idx < color_end; color_idx += 4) {
                color_data[color_idx] = cr;
                color_data[color_idx + 1] = cg;
                color_data[color_idx + 2] = cb;
                color_data[color_idx + 3] = ca;
            }

            vertices += this.vertices_per_quad;
        }

        return vertices;
    }

    /**
     * Populate an array with repeated copies of the given color
     */
    static populate_color_data(
        dest: Float32Array,
        color: Color,
        offset: number,
        length: number,
    ) {
        if (!color) {
            color = new Color(1, 0, 0, 1);
        }
        const color_data = color.to_array();
        for (let i = 0; i < length; i++) {
            dest[offset + i] = color_data[i % color_data.length]!;
        }
    }

    /**
     * Tesselate a line segment into a quad
     * @returns four points representing the line segment.
     */
    static tesselate_segment(
        p1: Vec2,
        p2: Vec2,
        width: number,
    ): [Vec2, Vec2, Vec2, Vec2] {
        const line = p2.sub(p1);
        const norm = line.normal.normalize();
        const n = norm.multiply(width / 2);
        const n2 = n.normal;

        const a = p1.add(n).add(n2);
        const b = p1.sub(n).add(n2);
        const c = p2.add(n).sub(n2);
        const d = p2.sub(n).sub(n2);

        return [a, b, c, d];
    }

    /**
     * Tesselate a Polyline into renderable data.
     */
    static tesselate_polyline(polyline: Polyline) {
        const width = polyline.width || 0;
        const points = polyline.points;
        const color = polyline.color;

        const segment_count = points.length - 1;
        const vertex_count = segment_count * this.vertices_per_quad;
        const position_data = new Float32Array(vertex_count * 2);
        const color_data = new Float32Array(vertex_count * 4);
        const cap_data = new Float32Array(vertex_count);
        let vertex_index = 0;

        for (let segment_num = 1; segment_num < points.length; segment_num++) {
            const p1 = points[segment_num - 1]!;
            const p2 = points[segment_num]!;

            const length = p2.sub(p1).magnitude;

            // skip zero-length segments
            if (length == 0) {
                continue;
            }

            const quad = this.tesselate_segment(p1, p2, width);
            const cap_region = width / (length + width);

            position_data.set(this.quad_to_triangles(quad), vertex_index * 2);
            cap_data.set(
                Array(this.vertices_per_quad).fill(cap_region),
                vertex_index,
            );
            this.populate_color_data(
                color_data,
                color as Color,
                vertex_index * 4,
                this.vertices_per_quad * 4,
            );

            vertex_index += this.vertices_per_quad;
        }

        return {
            position_array: position_data.slice(0, vertex_index * 2),
            cap_array: cap_data.slice(0, vertex_index),
            color_array: color_data.slice(0, vertex_index * 4),
        };
    }

    /**
     * Tesselate a circle into a quad
     * @returns four points representing the quad
     */
    static tesselate_circle(circle: Circle): [Vec2, Vec2, Vec2, Vec2] {
        const n = new Vec2(circle.radius, 0);
        const n2 = n.normal;

        const a = circle.center.add(n).add(n2);
        const b = circle.center.sub(n).add(n2);
        const c = circle.center.add(n).sub(n2);
        const d = circle.center.sub(n).sub(n2);

        return [a, b, c, d];
    }

    /**
     * Tesselate an array of circles into renderable data
     */
    static tesselate_circles(circles: Circle[]) {
        const vertex_count = circles.length * this.vertices_per_quad;
        const position_data = new Float32Array(vertex_count * 2);
        const cap_data = new Float32Array(vertex_count);
        const color_data = new Float32Array(vertex_count * 4);
        let vertex_index = 0;

        for (let i = 0; i < circles.length; i++) {
            const c = circles[i]!;
            const cap_region = 1.0;
            const quad = this.tesselate_circle(c);

            position_data.set(this.quad_to_triangles(quad), vertex_index * 2);

            cap_data.set(
                Array(this.vertices_per_quad).fill(cap_region),
                vertex_index,
            );

            this.populate_color_data(
                color_data,
                c.color as Color,
                vertex_index * 4,
                this.vertices_per_quad * 4,
            );

            vertex_index += this.vertices_per_quad;
        }

        return {
            position_array: position_data.slice(0, vertex_index * 2),
            cap_array: cap_data.slice(0, vertex_index),
            color_array: color_data.slice(0, vertex_index * 4),
        };
    }

    /**
     * Convert a point cloud polygon into an array of triangles.
     * Populates this.vertices with the triangles and clears this.points.
     */
    static triangulate_polygon(polygon: Polygon) {
        if (polygon.vertices) {
            return polygon;
        }

        polygon.vertices = triangulate(polygon.points);
        polygon.points = [];

        return polygon;
    }
}

/**
 * A set of filled circles.
 */
export class CircleSet implements IDisposable {
    shader: ShaderProgram;
    vao: VertexArray;
    position_buf: Buffer;
    cap_region_buf: Buffer;
    color_buf: Buffer;
    vertex_count: number;

    /**
     * Load the shader program required to render this primitive.
     */
    static async load_shader(gl: WebGL2RenderingContext) {
        // This re-uses the same shader that polyline uses, since the polyline
        // is pill-shaped, circle is just a special case of a zero-length polyline.
        return await ShaderProgram.load(
            gl,
            "polyline",
            polyline_vert_shader_src,
            polyline_frag_shader_src,
        );
    }

    /**
     * Create a new circle set.
     * @param shader - optional override for the shader program used when drawing.
     */
    constructor(
        public gl: WebGL2RenderingContext,
        shader: ShaderProgram,
    ) {
        this.shader = shader;
        this.vao = new VertexArray(gl);
        this.position_buf = this.vao.buffer(this.shader["a_position"], 2);
        this.cap_region_buf = this.vao.buffer(this.shader["a_cap_region"], 1);
        this.color_buf = this.vao.buffer(this.shader["a_color"], 4);
        this.vertex_count = 0;
    }

    /**
     * Release GPU resources
     */
    dispose() {
        this.vao.dispose();
        this.position_buf.dispose();
        this.cap_region_buf.dispose();
        this.color_buf.dispose();
    }

    /**
     * Tesselate an array of circles and upload them to the GPU.
     */
    set(circles: Circle[]) {
        const vertex_count = circles.length * Tesselator.vertices_per_quad;
        const position_data = new Float32Array(vertex_count * 2);
        const cap_data = new Float32Array(vertex_count);
        const color_data = new Float32Array(vertex_count * 4);
        let position_idx = 0;
        let cap_idx = 0;
        let color_idx = 0;

        for (let i = 0; i < circles.length; i++) {
            const c = circles[i]!;
            const quad = Tesselator.tesselate_circle(c);
            Tesselator.write_quad_triangles(position_data, position_idx, quad);
            position_idx += Tesselator.vertices_per_quad * 2;

            cap_data.fill(1.0, cap_idx, cap_idx + Tesselator.vertices_per_quad);
            cap_idx += Tesselator.vertices_per_quad;

            Tesselator.populate_color_data(
                color_data,
                c.color as Color,
                color_idx,
                Tesselator.vertices_per_quad * 4,
            );
            color_idx += Tesselator.vertices_per_quad * 4;
        }

        this.position_buf.set(position_data);
        this.cap_region_buf.set(cap_data);
        this.color_buf.set(color_data);
        this.vertex_count = position_data.length / 2;
    }

    render() {
        if (!this.vertex_count) {
            return;
        }
        this.vao.bind();
        this.gl.drawArrays(this.gl.TRIANGLES, 0, this.vertex_count);
    }
}

/**
 * A set of stroked polylines
 */
export class PolylineSet implements IDisposable {
    shader: ShaderProgram;
    vao: VertexArray;
    position_buf: Buffer;
    cap_region_buf: Buffer;
    color_buf: Buffer;
    vertex_count: number;

    /**
     * Load the shader program required to render this primitive.
     */
    static async load_shader(gl: WebGL2RenderingContext) {
        return await ShaderProgram.load(
            gl,
            "polyline",
            polyline_vert_shader_src,
            polyline_frag_shader_src,
        );
    }

    /**
     * Create a new polyline set.
     * @param {WebGL2RenderingContext} gl
     * @param {ShaderProgram?} shader - optional override for the shader program used when drawing.
     */
    constructor(
        public gl: WebGL2RenderingContext,
        shader: ShaderProgram,
    ) {
        this.shader = shader;
        this.vao = new VertexArray(gl);
        this.position_buf = this.vao.buffer(this.shader["a_position"], 2);
        this.cap_region_buf = this.vao.buffer(this.shader["a_cap_region"], 1);
        this.color_buf = this.vao.buffer(this.shader["a_color"], 4);
        this.vertex_count = 0;
    }

    /**
     * Release GPU resources
     */
    dispose() {
        this.vao.dispose();
        this.position_buf.dispose();
        this.cap_region_buf.dispose();
        this.color_buf.dispose();
    }

    /**
     * Tesselate an array of polylines and upload them to the GPU.
     */
    set(lines: Polyline[]) {
        if (!lines.length) {
            return;
        }

        const vertex_count = lines.reduce((v, e) => {
            return v + (e.points.length - 1) * Tesselator.vertices_per_quad;
        }, 0);

        const position_data = new Float32Array(vertex_count * 2);
        const cap_data = new Float32Array(vertex_count);
        const color_data = new Float32Array(vertex_count * 4);

        let position_idx = 0;
        let cap_idx = 0;
        let color_idx = 0;

        for (const line of lines) {
            const written = Tesselator.write_polyline(
                position_data,
                position_idx,
                cap_data,
                cap_idx,
                color_data,
                color_idx,
                line,
            );
            position_idx += written * 2;
            cap_idx += written;
            color_idx += written * 4;
        }

        this.position_buf.set(position_data.subarray(0, position_idx));
        this.cap_region_buf.set(cap_data.subarray(0, cap_idx));
        this.color_buf.set(color_data.subarray(0, color_idx));

        this.vertex_count = position_idx / 2;
    }

    render() {
        if (!this.vertex_count) {
            return;
        }
        this.vao.bind();
        this.gl.drawArrays(this.gl.TRIANGLES, 0, this.vertex_count);
    }
}

/**
 * A set of filled polygons
 */
export class PolygonSet implements IDisposable {
    shader: ShaderProgram;
    vao: VertexArray;
    position_buf: Buffer;
    color_buf: Buffer;
    vertex_count: number;

    /**
     * Load the shader program required to render this primitive.
     */
    static async load_shader(gl: WebGL2RenderingContext) {
        return await ShaderProgram.load(
            gl,
            "polygon",
            polygon_vert_shader_src,
            polygon_frag_shader_src,
        );
    }

    /**
     * Create a new polygon set.
     * @param {WebGL2RenderingContext} gl
     * @param {ShaderProgram?} shader - optional override for the shader program used when drawing.
     */
    constructor(
        public gl: WebGL2RenderingContext,
        shader: ShaderProgram,
    ) {
        this.shader = shader;
        this.vao = new VertexArray(gl);
        this.position_buf = this.vao.buffer(this.shader["a_position"], 2);
        this.color_buf = this.vao.buffer(this.shader["a_color"], 4);
        this.vertex_count = 0;
    }

    /**
     * Release GPU resources
     */
    dispose() {
        this.vao.dispose();
        this.position_buf.dispose();
        this.color_buf.dispose();
    }

    /**
     * Convert an array of triangle vertices to polylines.
     *
     * This is a helper function for debugging. It allows easily drawing the
     * outlines of the results of triangulation.
     *
     */
    static polyline_from_triangles(
        triangles: Float32Array,
        width: number,
        color: Color,
    ): Polyline[] {
        const lines: Polyline[] = [];
        for (let i = 0; i < triangles.length; i += 6) {
            const a = new Vec2(triangles[i], triangles[i + 1]);
            const b = new Vec2(triangles[i + 2], triangles[i + 3]);
            const c = new Vec2(triangles[i + 4], triangles[i + 5]);
            lines.push(new Polyline([a, b, c, a], width, color));
        }
        return lines;
    }

    /**
     * Tesselate (triangulate) and upload a list of polygons to the GPU.
     */
    set(polygons: Polygon[]) {
        let total_vertex_data_length = 0;

        for (const polygon of polygons) {
            Tesselator.triangulate_polygon(polygon);
            total_vertex_data_length += polygon.vertices?.length ?? 0;
        }

        const total_vertices = total_vertex_data_length / 2;

        const vertex_data = new Float32Array(total_vertex_data_length);
        const color_data = new Float32Array(total_vertices * 4);

        let vertex_data_idx = 0;
        let color_data_idx = 0;
        for (const polygon of polygons) {
            if (polygon.vertices == null) {
                continue;
            }

            const polygon_vertex_count = polygon.vertices.length / 2;

            vertex_data.set(polygon.vertices, vertex_data_idx);
            vertex_data_idx += polygon.vertices.length;

            Tesselator.populate_color_data(
                color_data,
                polygon.color as Color,
                color_data_idx,
                polygon_vertex_count * 4,
            );
            color_data_idx += polygon_vertex_count * 4;
        }

        this.position_buf.set(vertex_data);
        this.color_buf.set(color_data);
        this.vertex_count = vertex_data_idx / 2;
    }

    render() {
        if (!this.vertex_count) {
            return;
        }
        this.vao.bind();
        this.gl.drawArrays(this.gl.TRIANGLES, 0, this.vertex_count);
    }
}

/**
 * A set of primitives
 *
 * This is the primary interface to this module. It's used to collect a set
 * of primitives (circles, polylines, and polygons), upload their data to the
 * GPU, and draw them together. This is conceptually a "layer", all primitives
 * are drawn at the same depth.
 *
 * Like the underlying primitive sets, this is intended to be write once. Once
 * you call commit() the primitive data is released from working RAM and exists
 * only in the GPU buffers. To modify the data, you'd dispose() of this layer
 * and create a new one.
 *
 */

export enum ShaderTypes {
    PolygonSet = "polygon",
    PolylineSet = "polyline",
    CircleSet = "circle",
}

export class PrimitiveSet implements IDisposable {
    #polygons: Polygon[] = [];
    #circles: Circle[] = [];
    #lines: Polyline[] = [];

    #polygon_set?: PolygonSet;
    #circle_set?: CircleSet;
    #polyline_set?: PolylineSet;

    /**
     * Create a new primitive set
     */
    constructor(
        public gl: WebGL2RenderingContext,
        private readonly shader_programs: Map<ShaderTypes, ShaderProgram>,
    ) {
        this.gl = gl;
    }

    /**
     * Release GPU resources
     */
    dispose() {
        this.#polygon_set?.dispose();
        this.#circle_set?.dispose();
        this.#polyline_set?.dispose();
    }

    /**
     * Clear committed geometry
     */
    clear() {
        this.#polygon_set?.dispose();
        this.#circle_set?.dispose();
        this.#polyline_set?.dispose();

        this.#polygon_set = undefined;
        this.#circle_set = undefined;
        this.#polyline_set = undefined;

        this.#polygons = [];
        this.#circles = [];
        this.#lines = [];
    }

    /**
     * Collect a new filled circle
     */
    add_circle(circle: Circle) {
        this.#circles.push(circle);
    }

    /**
     * Collect a new filled polygon
     */
    add_polygon(polygon: Polygon) {
        this.#polygons.push(polygon);
    }

    /**
     * Collect a new polyline
     */
    add_line(line: Polyline) {
        this.#lines.push(line);
    }

    /**
     * Tesselate all collected primitives and upload their data to the GPU.
     */
    commit() {
        if (this.#polygons.length) {
            this.#polygon_set = new PolygonSet(
                this.gl,
                this.shader_programs.get(ShaderTypes.PolygonSet)!,
            );
            this.#polygon_set.set(this.#polygons);
            this.#polygons = undefined!;
        }
        if (this.#lines.length) {
            this.#polyline_set = new PolylineSet(
                this.gl,
                this.shader_programs.get(ShaderTypes.PolylineSet)!,
            );
            this.#polyline_set.set(this.#lines);
            this.#lines = undefined!;
        }
        if (this.#circles.length) {
            this.#circle_set = new CircleSet(
                this.gl,
                this.shader_programs.get(ShaderTypes.CircleSet)!,
            );
            this.#circle_set.set(this.#circles);
            this.#circles = undefined!;
        }
    }

    /**
     * Draw all the previously commit()ed primitives
     * @param matrix - complete view/projection matrix
     * @param depth - used for depth testing
     * @parama alpha - overrides the alpha for colors
     */
    render(matrix: Matrix3, depth = 0, alpha = 1) {
        if (this.#polygon_set) {
            this.#polygon_set.shader.bind();
            this.#polygon_set.shader["u_matrix"].mat3f(false, matrix.elements);
            this.#polygon_set.shader["u_depth"].f1(depth);
            this.#polygon_set.shader["u_alpha"].f1(alpha);
            this.#polygon_set.render();
        }

        if (this.#circle_set) {
            this.#circle_set.shader.bind();
            this.#circle_set.shader["u_matrix"].mat3f(false, matrix.elements);
            this.#circle_set.shader["u_depth"].f1(depth);
            this.#circle_set.shader["u_alpha"].f1(alpha);
            this.#circle_set.render();
        }

        if (this.#polyline_set) {
            this.#polyline_set.shader.bind();
            this.#polyline_set.shader["u_matrix"].mat3f(false, matrix.elements);
            this.#polyline_set.shader["u_depth"].f1(depth);
            this.#polyline_set.shader["u_alpha"].f1(alpha);
            this.#polyline_set.render();
        }
    }
}
