/**
 * three-cad-viewer - A CAD viewer built on Three.js
 *
 * This is the main entry point for the library.
 * It exports the core classes and all public TypeScript types.
 */

// CSS imports
import "../css/global.css";
import "../css/ui.css";
import "../css/treeview.css";
import "../css/tools.css";

// =============================================================================
// Core Classes
// =============================================================================

import { Viewer } from "./core/viewer.js";
import { Display } from "./ui/display.js";
import { EnvironmentManager } from "./rendering/environment.js";
import { Timer } from "./utils/timer.js";
import { logger } from "./utils/logger.js";
import { gpuTracker } from "./utils/gpu-tracker.js";
import { version } from "./_version.js";

export {
  Viewer,
  Display,
  EnvironmentManager,
  Timer,
  logger,
  gpuTracker,
  version,
};

// Material presets
export {
  MATERIAL_PRESETS,
  MATERIAL_PRESET_NAMES,
} from "./rendering/material-presets.js";

// Logger type export
export type { LogLevel } from "./utils/logger.js";

// GPU tracker type exports
export type {
  ResourceType,
  TrackedResource,
  ResourceSummary,
} from "./utils/gpu-tracker.js";

// =============================================================================
// Type Exports
// =============================================================================

// Re-export Three.js tuple types used in our API
export type { Vector3Tuple, QuaternionTuple } from "three";

// Basic types
export type {
  ThemeInput,
  Theme,
  ControlType,
  UpDirection,
  AnimationMode,
  ActiveTab,
  ZebraColorScheme,
  ZebraMappingMode,
  ShapeType,
  ShapeSubtype,
  Axis,
  ClipIndex,
  ColorValue,
  RGBColor,
  RGBAColor,
  AxisColors,
  AxisColorsFlatArray,
} from "./core/types.js";

// Type guards, constants, and enums
export { CLIP_INDICES, isClipIndex, CollapseState } from "./core/types.js";

// State change types
export type {
  StateChange,
  StateSubscriber,
  GlobalStateSubscriber,
} from "./core/types.js";

// Bounding box/sphere types
export type {
  BoundingBox,
  BoundingSphere,
  BoundingBoxFlat,
} from "./core/types.js";

// Pick info
export type { PickInfo } from "./core/types.js";

// Change notification types
export type {
  ChangeInfos,
  ChangeNotification,
  NotificationCallback,
} from "./core/types.js";

// Options types - these are the main configuration interfaces
export type {
  DisplayOptions,
  RenderOptions,
  ViewerOptions,
  ZebraOptions,
  CombinedOptions,
} from "./core/types.js";

// Viewer state shape
export type { ViewerStateShape, StateKey } from "./core/types.js";

// Shape and texture types - for working with CAD data
export type {
  Texture,
  Shape,
  ShapeBinary,
  ShapeNested,
  Location,
  VisibilityValue,
  VisibilityState,
  Shapes,
} from "./core/types.js";

// Shape type guards
export {
  isShapeBinaryFormat,
  hasTrianglesPerFace,
  hasSegmentsPerEdge,
} from "./core/types.js";

// DOM event callback
export type { DomEventCallback } from "./core/types.js";

// Material types
export type { ColoredMaterial } from "./core/types.js";

// Studio mode & PBR material types
export type {
  MaterialAppearance,
  MaterialXMaterial,
  StudioOptions,
  StudioBackground,
  StudioModeOptions,
  StudioEnvironment,
  StudioToneMapping,
  StudioTextureMapping,
} from "./core/types.js";

// MaterialX type guard
export { isMaterialXMaterial } from "./core/types.js";

// Instanced/compressed format decoding
export {
  isInstancedFormat,
  decodeInstancedFormat,
} from "./utils/decode-instances.js";

// Subscription options
export type { SubscribeOptions } from "./core/types.js";

// ---------------------------------------------------------------------------
// HAMMEROLA'S PATCH, and the whole reason this source is vendored rather than
// the built file taken from somebody else's package.
//
// UPSTREAM BUNDLES three into this library — its own rollup config has no
// `external: three` — so a page that loads the released file has a three
// instance it cannot name. Our viewport draws its manipulators as DOM elements
// over the canvas for exactly that reason, and they read as flat because they
// are. `viewer/rollup.config.mjs` is the other half of the patch: it makes
// three external and writes the hub's URL for it into the bundle.
//
// Re-exporting the namespace costs ONE LINE in the built bundle — `export
// { THREE };`, eighteen bytes — and no classes at all: the library itself does
// `import * as THREE from "three"`, so the namespace object already exists, and
// with three external its contents are not in this file to begin with.
// ---------------------------------------------------------------------------
export * as THREE from "three";
