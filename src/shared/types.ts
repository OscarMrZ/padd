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
