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
  /** SHA-1 of the image, so the same picture isn't added twice. */
  hash?: string;
  /** Where the image came from on this machine. */
  source?: string;
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
  /** Repo-relative folders whose new or changed images become boards on their own. */
  watch?: string[];
}

/** One entry in a subproject's conversation between the tablet and Claude. */
export interface Message {
  id: string;
  author: Author;
  text: string;
  t: number;
  /** The board it is about. */
  board?: string;
  /** For a Send: the board flattened with your marks, as Claude saw it. */
  snapshot?: string;
  /** For a Send: whether a Claude session has received it yet. */
  delivered?: boolean;
}

/** Whether a Claude session is connected for a subproject right now. */
export interface SessionState {
  live: boolean;
  /** The Claude Code session id linked to the subproject, if any. */
  session?: string;
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
  /** Whether a Claude session is connected for each subproject. */
  live: Record<string, boolean>;
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
  | { type: "subproject"; project: string; subproject: Subproject }
  | ({ type: "message"; message: Message } & Place)
  | ({ type: "session"; state: SessionState } & Place)
  /** Claude asks the tablet to show this board. */
  | ({ type: "focus"; board: string } & Place);
