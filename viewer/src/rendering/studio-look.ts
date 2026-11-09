/**
 * HAMMEROLA'S PATCH: what Studio (`Viewer.setStudio`) puts into a scene — a
 * studio room as the environment every face reflects, a light from the sky and
 * the ground, a key and a fill that turn with the camera, and a soft shadow on
 * the ground under the model.
 *
 * Not the library's own Studio mode (studio-manager.ts): that one swaps in
 * materials shared between parts, which loses a part's own transparency. This
 * one leaves the materials alone.
 *
 * The values are those of https://seguar.github.io/rfsoc-pulse-array/#mech,
 * written for a three before r155: the light intensities are multiplied by π
 * into today's units — exactly, not through `scaleLight`, which rounds the
 * product to a whole number (the fill would come out 9 % dimmer, the sky 16 %
 * brighter).
 */
import * as THREE from "three";
import { deepDispose } from "../utils/utils.js";

/** A light intensity of a three before r155, in today's units. */
const legacy = (k: number): number => Math.PI * k;

/** The exposure of Studio's ACES tone mapping. */
export const STUDIO_EXPOSURE = 0.95;

/**
 * The key and the fill as directions in the camera's frame (x right, y up, z
 * toward the reader): the rig turns with the camera, so whichever side the
 * reader turns the model to is lit.
 */
const KEY_DIRECTION = new THREE.Vector3(-0.35, 1, 0.75).normalize();
const FILL_DIRECTION = new THREE.Vector3(-0.8, 0.4, -0.6).normalize();

/** The blur the room is prefiltered with (`PMREMGenerator.fromScene`). */
const ROOM_BLUR = 0.035;

/** How much wider than the model's footprint its ground shadow is. */
const GROUND_SPREAD = 1.3;

/** The ground shadow's opacity from its centre (0) to its rim (1). */
const GROUND_STOPS: readonly [number, number][] = [
  [0, 0.42],
  [0.45, 0.26],
  [0.75, 0.09],
  [1, 0],
];

/** The side of the canvas the ground shadow is painted on, in pixels. */
const GROUND_TEXTURE_SIZE = 256;

/** A colour as bright as `k`, above 1 for the panels that light the room. */
const glow = (k: number): THREE.Color => new THREE.Color().setScalar(k);

/**
 * The room, Y-up: grey walls, a darker floor, and four lit panels — the
 * ceiling, a soft box on the left, a dim one on the right and one in front.
 */
function buildRoom(): THREE.Scene {
  const room = new THREE.Scene();
  const walls = new THREE.Mesh(
    new THREE.BoxGeometry(10, 6, 10),
    new THREE.MeshBasicMaterial({ color: 0x8a9096, side: THREE.BackSide }),
  );
  walls.position.y = 2;
  room.add(walls);

  const panel = (
    width: number,
    height: number,
    position: [number, number, number],
    rotationX: number,
    rotationY: number,
    color: THREE.Color,
  ): void => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(width, height),
      new THREE.MeshBasicMaterial({ color, side: THREE.DoubleSide }),
    );
    mesh.position.set(...position);
    mesh.rotation.set(rotationX, rotationY, 0);
    room.add(mesh);
  };
  panel(6, 4, [0, 4.9, 0], Math.PI / 2, 0, glow(2.2));
  panel(3, 3, [-4.9, 2.2, 1], 0, Math.PI / 2, glow(1.4));
  panel(3, 3, [4.9, 2.6, -1], 0, -Math.PI / 2, glow(0.55));
  panel(4, 2.5, [0, 2.2, 4.9], 0, Math.PI, glow(1.6));
  panel(10, 10, [0, -0.95, 0], -Math.PI / 2, 0, new THREE.Color(0x5b6168));
  return room;
}

/** The ground shadow: black, its opacity falling off from the centre by `GROUND_STOPS`. */
function groundTexture(): THREE.CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = GROUND_TEXTURE_SIZE;
  canvas.height = GROUND_TEXTURE_SIZE;
  const context = canvas.getContext("2d")!;
  const r = GROUND_TEXTURE_SIZE / 2;
  const gradient = context.createRadialGradient(r, r, 0, r, r, r);
  for (const [stop, alpha] of GROUND_STOPS) {
    gradient.addColorStop(stop, `rgba(0,0,0,${alpha})`);
  }
  context.fillStyle = gradient;
  context.fillRect(0, 0, GROUND_TEXTURE_SIZE, GROUND_TEXTURE_SIZE);
  return new THREE.CanvasTexture(canvas);
}

/**
 * The lights, the room and the ground shadow, built once per Viewer and moved
 * from scene to scene: `attach` puts them into a scene, `detach` takes them out
 * before the scene is disposed, so they outlive it.
 */
class StudioLook {
  private readonly _sky = new THREE.HemisphereLight(
    0xffffff,
    0x9aa3ad,
    legacy(0.55),
  );
  private readonly _key = new THREE.DirectionalLight(0xffffff, legacy(1.1));
  private readonly _fill = new THREE.DirectionalLight(0xffffff, legacy(0.35));
  private readonly _groundTexture = groundTexture();
  private readonly _ground = new THREE.Mesh(
    new THREE.PlaneGeometry(1, 1),
    new THREE.MeshBasicMaterial({
      map: this._groundTexture,
      transparent: true,
      depthWrite: false,
      toneMapped: false,
    }),
  );
  /** The room prefiltered for the renderer, made on the first `attach`. */
  private _environment: THREE.WebGLRenderTarget | null = null;

  constructor() {
    // Scenery: no ray finds it, so no tool or menu takes it for a part.
    this._ground.raycast = () => {};
  }

  /**
   * Put the look into `scene`: the room as its environment, the lights, and
   * the ground shadow under `box` (the parts), at its lowest point along the
   * up axis and `GROUND_SPREAD` times its footprint.
   */
  attach(
    scene: THREE.Scene,
    renderer: THREE.WebGLRenderer,
    box: THREE.Box3,
    upIsZ: boolean,
  ): void {
    if (this._environment === null) {
      const room = buildRoom();
      const generator = new THREE.PMREMGenerator(renderer);
      this._environment = generator.fromScene(room, ROOM_BLUR);
      generator.dispose();
      deepDispose(room);
    }
    scene.environment = this._environment.texture;
    // The room is built Y-up; for a Z-up scene its ceiling is turned to +Z.
    scene.environmentRotation.set(upIsZ ? Math.PI / 2 : 0, 0, 0);
    // The sky's colour comes from the up axis, the ground's from below.
    this._sky.position.set(0, upIsZ ? 0 : 1, upIsZ ? 1 : 0);

    const size = box.getSize(new THREE.Vector3());
    const centre = box.getCenter(new THREE.Vector3());
    if (upIsZ) {
      this._ground.rotation.set(0, 0, 0);
      this._ground.position.set(centre.x, centre.y, box.min.z);
      this._ground.scale.set(size.x * GROUND_SPREAD, size.y * GROUND_SPREAD, 1);
    } else {
      // The plane faces +Z as built; laid down it faces +Y, its height along -Z.
      this._ground.rotation.set(-Math.PI / 2, 0, 0);
      this._ground.position.set(centre.x, box.min.y, centre.z);
      this._ground.scale.set(size.x * GROUND_SPREAD, size.z * GROUND_SPREAD, 1);
    }

    scene.add(this._sky, this._key, this._fill, this._ground);
  }

  /** Take the look out of `scene`, which is left as a fresh scene is. */
  detach(scene: THREE.Scene): void {
    scene.environment = null;
    scene.environmentRotation.set(0, 0, 0);
    scene.remove(this._sky, this._key, this._fill, this._ground);
  }

  /** Turn the key and the fill with `camera`; their targets stay at the origin. */
  aim(camera: THREE.Camera): void {
    this._key.position.copy(KEY_DIRECTION).applyQuaternion(camera.quaternion);
    this._fill.position.copy(FILL_DIRECTION).applyQuaternion(camera.quaternion);
  }

  dispose(): void {
    this._environment?.dispose();
    this._ground.geometry.dispose();
    this._ground.material.dispose();
    this._groundTexture.dispose();
  }
}

export { StudioLook };
