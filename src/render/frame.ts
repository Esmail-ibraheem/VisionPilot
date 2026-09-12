/**
 * World → scene frame mapping.
 * The world frame (src/world/types.ts) has +x to the ego's right and +z forward. A Three.js camera
 * looking along +z sees world +x on the LEFT of the screen, so the renderer mirrors x. Headings
 * are mirrored accordingly. Every world→scene conversion goes through these helpers.
 */
export const toSceneX = (x: number): number => -x;
export const toSceneHeading = (heading: number): number => -heading;
