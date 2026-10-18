// Shapes shared by the daemon, the MCP server and the tablet UI.

/** Who made a mark: the person at the tablet, or Claude. */
export type Author = "me" | "claude";

export type Tool = "pen" | "highlighter";

/** One point in image pixels, with pen pressure in [0, 1]. */
export type Point = [x: number, y: number, pressure: number];

export interface Stroke {
  id: string;
  author: Author;
  tool: Tool;
  color: string;
  /** Base width in image pixels; pressure scales it for the pen. */
  size: number;
  points: Point[];
  t: number;
}

export interface Board {
  id: string;
  title: string;
  /** File name of the image inside the board folder. */
  image: string;
  author: Author;
  t: number;
}

/** A board with its current ink, as the UI loads it. */
export interface BoardInk {
  board: Board;
  strokes: Stroke[];
}

/** A line of work inside a project, e.g. "mood" in tofu. */
export interface Subproject {
  id: string;
  title: string;
  /** What the work is about; a new session starts from it. */
  brief: string;
}

/** The committed `.padd/config.json` of a repo. */
export interface ProjectConfig {
  name: string;
  subprojects: Subproject[];
}

export interface ProjectInfo extends ProjectConfig {
  id: string;
  path: string;
}

/** A project as the tablet lists it: config plus how many boards each subproject holds. */
export interface ProjectSummary extends ProjectInfo {
  boards: Record<string, number>;
}

/** Where an event happened. */
export interface Place {
  project: string;
  sub: string;
}

/**
 * Live changes, streamed to every open tablet view over /api/events.
 * `origin` is the client that caused it, so that client can skip its own echo.
 */
export type PaddEvent =
  | ({ type: "board"; board: Board } & Place)
  | ({ type: "stroke"; board: string; stroke: Stroke; origin?: string } & Place)
  | ({ type: "erase"; board: string; ids: string[]; origin?: string } & Place)
  | { type: "subproject"; project: string; subproject: Subproject };
