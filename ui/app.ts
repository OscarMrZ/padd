// The tablet UI shell: which project and subproject you're in, the filmstrip of its images,
// and live updates from padd serve. Drawing itself lives in board.ts.

import type { Board, BoardInk, Message, PaddEvent, ProjectSummary, SessionState, Subproject } from "../src/shared/types.ts";
import { api, clientId, enc, remember, toast } from "./api.ts";
import { COLORS, createBoardView, type Mode } from "./board.ts";

const $ = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;

const view = createBoardView($<HTMLElement>(".stage"));

const state = {
  projects: [] as ProjectSummary[],
  project: null as ProjectSummary | null,
  sub: null as Subproject | null,
  /** The subproject's boards, newest first. */
  boards: [] as Board[],
  board: null as Board | null,
  seen: new Set<string>(),
  follow: remember.get("padd.follow") !== "off",
  /** The subproject's conversation with Claude, oldest first. */
  messages: [] as Message[],
  session: { live: false } as SessionState,
  unread: 0,
  online: false,
  /** Bumped on every navigation, so a slow load can't land on top of a newer one. */
  seq: 0,
};

const base = () => `/api/p/${enc(state.project!.id, state.sub!.id)}/boards`;

// ---------- navigation ----------

async function loadProjects(): Promise<void> {
  state.projects = await api<ProjectSummary[]>("/api/projects");
}

/** Opens a subproject (and one of its boards, else the newest). */
async function go(projectId: string, subId: string, boardId?: string): Promise<void> {
  const project = state.projects.find((p) => p.id === projectId);
  const sub = project?.subprojects.find((s) => s.id === subId);
  if (!project || !sub) {
    toast(`${projectId}/${subId} isn't there any more`);
    return openNav();
  }
  const seq = ++state.seq;
  const at = `/api/p/${enc(project.id, sub.id)}`;
  const [boards, messages, session] = await Promise.all([
    api<Board[]>(`${at}/boards`),
    api<Message[]>(`${at}/messages`),
    api<SessionState>(`${at}/session`),
  ]);
  if (seq !== state.seq) return;
  Object.assign(state, { project, sub, boards: boards.reverse(), board: null, messages, session, unread: 0 });
  renderPresence();
  renderMessages();
  closeNav();
  // What is already there when you arrive counts as seen; only arrivals get the dot.
  state.seen = new Set(boards.map((b) => b.id));
  remember.set("padd.place", `${project.id}/${sub.id}`);
  renderPlace();
  const pick = state.boards.find((b) => b.id === boardId) ?? state.boards[0];
  if (pick) await openBoard(pick.id);
  else {
    view.close();
    $<HTMLButtonElement>(".send").disabled = true;
    renderStrip();
    syncHash();
  }
}

async function openBoard(id: string): Promise<void> {
  const seq = ++state.seq;
  const data = await api<BoardInk>(`${base()}/${enc(id)}`);
  const image = new Image();
  image.src = `${base()}/${enc(id)}/image`;
  await image.decode();
  if (seq !== state.seq) return;
  state.board = data.board;
  state.seen.add(id);
  view.open(`${base()}/${enc(id)}`, data, image);
  $<HTMLButtonElement>(".send").disabled = false;
  renderStrip();
  syncHash();
}

function step(delta: number): void {
  const i = state.boards.findIndex((b) => b.id === state.board?.id);
  const next = state.boards[i + delta];
  if (next) void openBoard(next.id);
}

/** #/<project>/<sub>/<board> keeps your place across reloads. */
function syncHash(): void {
  if (!state.project || !state.sub) return;
  const hash = `#/${enc(state.project.id, state.sub.id)}${state.board ? `/${enc(state.board.id)}` : ""}`;
  if (location.hash !== hash) history.replaceState(null, "", hash);
}

function parseHash(): [string, string, string | undefined] | null {
  const [project, sub, board] = location.hash.replace(/^#\/?/, "").split("/").map(decodeURIComponent);
  return project && sub ? [project, sub, board] : null;
}

// ---------- rendering ----------

function renderPlace(): void {
  $(".place .project").textContent = state.project?.name ?? "Choose a project";
  $(".place .sub").textContent = state.sub?.title ?? "";
  document.title = state.sub ? `${state.sub.title} in ${state.project!.name} (PADD)` : "PADD";
}

function renderStrip(): void {
  const strip = $<HTMLElement>(".strip");
  const empty = $<HTMLElement>(".empty");
  strip.hidden = !state.sub;
  empty.hidden = state.boards.length > 0;
  if (state.sub && state.boards.length === 0) {
    empty.textContent = `No images in ${state.sub.title} yet. Add a photo below, or they appear here as soon as Claude shows them.`;
  }
  const i = state.boards.findIndex((b) => b.id === state.board?.id);
  $(".board-title").textContent = state.board?.title ?? "";
  $(".count").textContent = i >= 0 ? `${state.boards.length - i} of ${state.boards.length}` : `${state.boards.length} images`;

  // Reuse thumbnails already on screen: images arrive often and the strip must not flicker.
  const thumbs = $<HTMLElement>(".thumbs");
  const existing = new Map([...thumbs.children].map((el) => [(el as HTMLElement).dataset.board!, el as HTMLElement]));
  const wanted = state.boards.map((b) => existing.get(b.id) ?? makeThumb(b));
  for (const el of existing.values()) if (!wanted.includes(el)) el.remove();
  wanted.forEach((el, n) => {
    if (thumbs.children[n] !== el) thumbs.insertBefore(el, thumbs.children[n] ?? null);
    const id = el.dataset.board!;
    el.setAttribute("aria-selected", String(id === state.board?.id));
    el.classList.toggle("unseen", !state.seen.has(id));
  });
  thumbs.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

function makeThumb(b: Board): HTMLElement {
  const btn = document.createElement("button");
  btn.className = "thumb";
  btn.dataset.board = b.id;
  btn.setAttribute("role", "option");
  btn.title = b.title;
  const img = document.createElement("img");
  img.alt = b.title;
  img.loading = "lazy";
  img.decoding = "async";
  img.src = `${base()}/${enc(b.id)}/thumb`;
  btn.append(img);
  return btn;
}

// ---------- navigator ----------

const nav = $<HTMLElement>(".nav");
const placeBtn = $<HTMLButtonElement>(".place");

function openNav(adding?: string): void {
  renderNav(adding);
  nav.hidden = false;
  placeBtn.setAttribute("aria-expanded", "true");
}

function closeNav(): void {
  nav.hidden = true;
  placeBtn.setAttribute("aria-expanded", "false");
}

function renderNav(adding?: string): void {
  if (state.projects.length === 0) {
    nav.replaceChildren(
      el("p", { class: "none" }, "No projects yet. Run padd init in a repo on your computer, then open this menu again."),
    );
    return;
  }
  nav.replaceChildren(
    ...state.projects.map((p) => {
      const section = el("section", { class: "project" });
      section.append(el("h2", {}, p.name), el("p", { class: "path" }, p.path));
      if (p.subprojects.length === 0) section.append(el("p", { class: "none" }, "No subprojects yet."));
      const list = el("ul", { class: "subs" });
      for (const s of p.subprojects) {
        const n = p.boards[s.id] ?? 0;
        const b = el("button", { "data-project": p.id, "data-sub": s.id });
        b.setAttribute("aria-current", String(p.id === state.project?.id && s.id === state.sub?.id));
        const count = n === 1 ? "1 image" : `${n} images`;
        b.append(el("span", { class: "title" }, s.title), el("span", { class: "n" }, p.live[s.id] ? `${count}, Claude here` : count));
        if (s.brief) b.append(el("span", { class: "brief" }, s.brief));
        list.append(el("li", {}, b));
      }
      section.append(list);
      if (adding === p.id) section.append(subprojectForm(p));
      else section.append(el("button", { class: "add", "data-add": p.id }, "New subproject"));
      return section;
    }),
  );
}

function subprojectForm(p: ProjectSummary): HTMLFormElement {
  const form = el("form") as HTMLFormElement;
  const name = el("input", { name: "title", required: "", maxlength: "60", autocomplete: "off" }) as HTMLInputElement;
  const brief = el("textarea", { name: "brief", maxlength: "4000" }) as HTMLTextAreaElement;
  const start = el("input", { type: "checkbox", name: "start", checked: "" }) as HTMLInputElement;
  const error = el("p", { class: "error", role: "alert" });
  error.hidden = true;
  form.append(
    el("label", {}, "Name", name),
    el("label", {}, "Brief: what this work is about", brief),
    el("label", { class: "check" }, start, "Start a Claude session for it (in the background)"),
    error,
    el("div", { class: "actions" }, el("button", { type: "button", class: "ghost", "data-cancel": "" }, "Cancel"), el("button", { class: "primary" }, "Create subproject")),
  );
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const sub = await api<Subproject>(`/api/p/${enc(p.id)}/subprojects`, { title: name.value, brief: brief.value });
      await loadProjects();
      closeNav();
      await go(p.id, sub.id);
      if (start.checked) await sessionAction("start");
    } catch (err) {
      error.textContent = (err as Error).message;
      error.hidden = false;
    }
  });
  queueMicrotask(() => name.focus());
  return form;
}

function el(tag: string, attrs: Record<string, string> = {}, ...children: (Node | string)[]): HTMLElement {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...children);
  return node;
}

// ---------- live updates ----------

function listen(): void {
  const source = new EventSource("/api/events");
  let dropped = false;
  source.onopen = () => {
    state.online = true;
    renderPresence();
    // Catch up on whatever happened while the stream was down.
    if (dropped) void resync();
    dropped = false;
  };
  source.onerror = () => {
    dropped = true;
    state.online = false;
    setStatus("Reconnecting", "error");
  };
  source.onmessage = (m) => onEvent(JSON.parse(m.data as string) as PaddEvent);
}

function onEvent(e: PaddEvent): void {
  if (e.type === "subproject") {
    const p = state.projects.find((x) => x.id === e.project);
    if (p && !p.subprojects.some((s) => s.id === e.subproject.id)) p.subprojects.push(e.subproject);
    if (!nav.hidden && !nav.querySelector("form")) renderNav();
    return;
  }
  const here = e.project === state.project?.id && e.sub === state.sub?.id;
  if (e.type === "session") {
    const p = state.projects.find((x) => x.id === e.project);
    if (p) p.live[e.sub] = e.state.live;
    if (here) {
      state.session = e.state;
      renderPresence();
      // Connection events don't know about windows: ask for the full picture.
      if (e.state.running === undefined) void refreshSession();
    }
    return;
  }
  if (e.type === "message") {
    if (here) receive(e.message);
    return;
  }
  if (e.type === "focus") {
    // Claude asked for this board: show it, unless the pen is down.
    if (here && !view.busy() && state.boards.some((b) => b.id === e.board)) void openBoard(e.board);
    return;
  }
  if (e.type === "board") {
    const p = state.projects.find((x) => x.id === e.project);
    if (p) p.boards[e.sub] = (p.boards[e.sub] ?? 0) + 1;
    if (!here || state.boards.some((b) => b.id === e.board.id)) return;
    state.boards.unshift(e.board);
    renderStrip();
    $(`.thumb[data-board="${e.board.id}"]`)?.classList.add("arrived");
    if (state.follow && !view.busy()) void openBoard(e.board.id);
    return;
  }
  if (!here || e.board !== state.board?.id || e.origin === clientId) return;
  if (e.type === "stroke") view.remoteStroke(e.stroke);
  else view.remoteErase(e.ids);
}

async function resync(): Promise<void> {
  await loadProjects();
  if (state.project && state.sub) await go(state.project.id, state.sub.id, state.board?.id);
}

function renderPresence(): void {
  if (!state.online) return;
  const s = state.session;
  if (s.live) setStatus("Claude here", "claude");
  else if (s.running) setStatus(s.needsTrust ? "Claude waits for you" : "Claude starting", "starting");
  else setStatus("Claude away", "idle");
  if (!sessionPop.hidden) renderSessionPop();
}

// ---------- the session: start it, show its window ----------

const sessionPop = $<HTMLElement>(".session-pop");
const statusBtn = $<HTMLButtonElement>(".status");

function openSessionPop(): void {
  if (!state.sub || !state.online) return;
  replyCard.hidden = true;
  renderSessionPop();
  sessionPop.hidden = false;
  statusBtn.setAttribute("aria-expanded", "true");
}

function closeSessionPop(): void {
  sessionPop.hidden = true;
  statusBtn.setAttribute("aria-expanded", "false");
}

function renderSessionPop(): void {
  const s = state.session;
  const title = state.sub?.title ?? "";
  const cmd = `padd attach ${state.project?.id}/${state.sub?.id}`;
  const hint = el("p", { class: "note" }, "On the computer, ", el("code", {}, cmd), " opens it in any terminal.");
  const parts: (Node | string)[] = [];
  const actions = el("div", { class: "actions" });
  if (s.live) {
    parts.push(el("p", {}, `Claude is working on ${title}. Your Sends go straight to it.`));
    if (s.running) {
      parts.push(hint);
      actions.append(el("button", { class: "primary", "data-session": "window" }, "Show its window on the computer"));
    } else parts.push(el("p", { class: "note" }, "It runs in a terminal you started yourself, on the computer."));
  } else if (s.running) {
    parts.push(
      el("p", {}, s.needsTrust
        ? "Claude Code asks whether you trust this project's folder. Answer it on the computer."
        : `Claude is starting for ${title} in the background.`),
      hint,
    );
    actions.append(el("button", { class: "primary", "data-session": "window" }, "Show its window on the computer"));
  } else {
    parts.push(
      el("p", {}, s.session
        ? `Claude isn't running for ${title}. Start it to pick up the conversation where it left off.`
        : `${title} has no Claude session yet. Start one to begin from its brief.`),
      el("p", { class: "note" }, "It runs in the background on the computer. Sends you make meanwhile wait for it."),
    );
    actions.append(el("button", { class: "primary", "data-session": "start" }, "Start Claude"));
  }
  if (actions.childElementCount > 0) parts.push(actions);
  sessionPop.replaceChildren(...parts);
}

async function sessionAction(action: "start" | "window"): Promise<void> {
  if (!state.project || !state.sub) return;
  try {
    const { result } = await api<{ result: string }>(`/api/p/${enc(state.project.id, state.sub.id)}/session/${action}`, {});
    const said: Record<string, string> = {
      started: "Starting Claude in the background",
      running: "Claude is already running on the computer",
      opened: "Window opened on the computer",
      "already open": "Its window is already open on the computer",
    };
    toast(said[result] ?? "Done", "ok");
    await refreshSession();
  } catch (err) {
    toast((err as Error).message);
  }
}

async function refreshSession(): Promise<void> {
  if (!state.project || !state.sub) return;
  const place = `${state.project.id}/${state.sub.id}`;
  const s = await api<SessionState>(`/api/p/${enc(state.project.id, state.sub.id)}/session`);
  if (place !== `${state.project?.id}/${state.sub?.id}`) return;
  state.session = { ...s, needsTrust: s.running && !s.live ? state.session.needsTrust : false };
  renderPresence();
}

function setStatus(text: string, s: "claude" | "starting" | "idle" | "error"): void {
  const status = $<HTMLElement>(".status");
  status.textContent = text;
  status.dataset.state = s;
}

// ---------- adding images from the tablet ----------

const PHOTO_MAX = 3000; // px on the long side: plenty to draw on, light over Wi-Fi

/**
 * Re-encodes a picked image: upright (camera orientation applied) and at most PHOTO_MAX px.
 * Photos become JPEG; PNG and WebP (screenshots, drawings) stay lossless as PNG.
 */
async function prepare(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  const k = Math.min(1, PHOTO_MAX / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * k);
  canvas.height = Math.round(bitmap.height * k);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return file.type === "image/jpeg" ? canvas.toDataURL("image/jpeg", 0.9) : canvas.toDataURL("image/png");
}

const addImage = $<HTMLLabelElement>(".add-image");
addImage.querySelector("input")!.addEventListener("change", async (e) => {
  const input = e.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (!state.project || !state.sub || files.length === 0) return;
  addImage.setAttribute("aria-busy", "true");
  let last: Board | undefined;
  try {
    for (const file of files) {
      const title = file.name.replace(/\.[^.]+$/, "").slice(0, 80) || "Photo";
      last = await api<Board>(`/api/p/${enc(state.project.id, state.sub.id)}/boards`, { image: await prepare(file), title });
    }
    // The board event adds it to the strip; open the (last) one just added.
    if (last) await openBoard(last.id);
  } catch (err) {
    toast(`Image not added: ${(err as Error).message}`);
  } finally {
    addImage.removeAttribute("aria-busy");
  }
});

// ---------- talking to Claude ----------

const composer = $<HTMLFormElement>(".composer");
const talk = $<HTMLElement>(".talk-panel");
const talkBtn = $<HTMLButtonElement>(".talk");
const replyCard = $<HTMLButtonElement>(".reply-card");
let replyTimer = 0;

function openComposer(): void {
  if (!state.board || !state.sub) return;
  const who = composer.querySelector(".who")!;
  who.replaceChildren(
    ...(state.session.live
      ? ["To Claude in ", el("strong", {}, state.sub.title), ", with this image and your marks."]
      : ["No Claude session for ", el("strong", {}, state.sub.title), " is connected. Your Send waits and goes out as soon as one starts."]),
  );
  composer.hidden = false;
  replyCard.hidden = true;
  $(".send").setAttribute("aria-expanded", "true");
  composer.querySelector("textarea")!.focus();
}

function closeComposer(): void {
  composer.hidden = true;
  $(".send").setAttribute("aria-expanded", "false");
}

composer.addEventListener("submit", async (e) => {
  e.preventDefault();
  const snapshot = view.snapshot();
  if (!snapshot || !state.board) return;
  const textarea = composer.querySelector("textarea")!;
  const button = composer.querySelector<HTMLButtonElement>(".primary")!;
  button.disabled = true;
  try {
    const { message, delivered } = await api<{ message: Message; delivered: boolean }>(
      `/api/p/${enc(state.project!.id, state.sub!.id)}/send`,
      { board: state.board.id, text: textarea.value, snapshot },
    );
    receive(message);
    textarea.value = "";
    closeComposer();
    toast(delivered ? "Sent to Claude" : "Saved. It goes to Claude when a session connects.", "ok");
  } catch (err) {
    toast(`Not sent: ${(err as Error).message}`);
  } finally {
    button.disabled = false;
  }
});

function openTalk(): void {
  talk.hidden = false;
  talkBtn.setAttribute("aria-expanded", "true");
  state.unread = 0;
  replyCard.hidden = true;
  renderMessages();
}

function closeTalk(): void {
  talk.hidden = true;
  talkBtn.setAttribute("aria-expanded", "false");
}

/** A message arrived or changed (e.g. a Send was delivered). */
function receive(m: Message): void {
  const i = state.messages.findIndex((x) => x.id === m.id);
  if (i >= 0) state.messages[i] = m;
  else {
    state.messages.push(m);
    if (m.author === "claude" && talk.hidden) {
      state.unread++;
      replyCard.textContent = m.text;
      replyCard.hidden = false;
      clearTimeout(replyTimer);
      replyTimer = window.setTimeout(() => (replyCard.hidden = true), 15_000);
    }
  }
  renderMessages();
}

function renderMessages(): void {
  const badge = $<HTMLElement>(".badge");
  badge.hidden = state.unread === 0;
  badge.textContent = String(state.unread);
  if (talk.hidden) return;
  const list = $<HTMLElement>(".messages");
  if (state.messages.length === 0) {
    list.replaceChildren(el("li", { class: "none" }, "Nothing yet. Mark up an image and press Send to Claude."));
    return;
  }
  list.replaceChildren(
    ...state.messages.map((m) => {
      const li = el("li", { class: `msg ${m.author}` }, m.text || (m.author === "me" ? "(just the marks)" : ""));
      const meta = el("div", { class: "meta" }, time(m.t));
      const board = m.board ? state.boards.find((b) => b.id === m.board) : undefined;
      if (board) meta.append(el("button", { class: "on", "data-board": board.id }, board.title));
      if (m.author === "me" && m.delivered === false) meta.append(el("span", { class: "waiting" }, "waiting for Claude"));
      li.append(meta);
      return li;
    }),
  );
  list.lastElementChild?.scrollIntoView({ block: "end" });
}

function time(t: number): string {
  return new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

// ---------- controls ----------

function setMode(mode: Mode): void {
  view.setMode(mode);
  for (const b of document.querySelectorAll<HTMLButtonElement>(".tool")) {
    b.setAttribute("aria-pressed", String(b.dataset.tool === mode));
  }
}

function setColor(color: string): void {
  view.setColor(color);
  for (const b of document.querySelectorAll<HTMLButtonElement>(".swatch")) {
    b.setAttribute("aria-checked", String(b.dataset.color === color));
  }
  if ($(".stage").getAttribute("data-tool") === "eraser") setMode("pen");
}

function setSize(size: number): void {
  view.setSize(size);
  for (const b of document.querySelectorAll<HTMLButtonElement>(".size")) {
    b.setAttribute("aria-checked", String(Number(b.dataset.size) === size));
  }
}

for (const c of COLORS) {
  const b = el("button", { class: "swatch", role: "radio", "aria-label": c.name, "data-color": c.value });
  b.style.setProperty("--c", c.value);
  $(".swatches").append(b);
}
for (const b of document.querySelectorAll<HTMLButtonElement>(".size")) b.setAttribute("role", "radio");

document.addEventListener("click", (e) => {
  const target = e.target as Element;
  if (!nav.hidden && !nav.contains(target) && !placeBtn.contains(target)) closeNav();
  if (!composer.hidden && !composer.contains(target) && !target.closest(".send")) closeComposer();
  if (!sessionPop.hidden && !sessionPop.contains(target) && !statusBtn.contains(target)) closeSessionPop();
  const b = target.closest<HTMLButtonElement>("button");
  if (!b) return;
  const d = b.dataset;
  if (b === placeBtn) return nav.hidden ? openNav() : closeNav();
  if (b.classList.contains("send")) return composer.hidden ? openComposer() : closeComposer();
  if (b === statusBtn) return sessionPop.hidden ? openSessionPop() : closeSessionPop();
  if (d.session === "start" || d.session === "window") {
    closeSessionPop();
    return void sessionAction(d.session);
  }
  if (b === talkBtn || b === replyCard) return talk.hidden ? openTalk() : closeTalk();
  if (d.close === "composer") return closeComposer();
  if (d.close === "talk") return closeTalk();
  if (d.tool) setMode(d.tool as Mode);
  else if (d.color) setColor(d.color);
  else if (d.size) setSize(Number(d.size));
  else if (d.act === "undo") void view.undo();
  else if (d.act === "fit") view.fit();
  else if (d.board) void openBoard(d.board);
  else if (d.add) renderNav(d.add);
  else if (d.cancel !== undefined) renderNav();
  else if (d.project && d.sub) {
    closeNav();
    void go(d.project, d.sub);
  }
});

$<HTMLInputElement>(".follow input").checked = state.follow;
$<HTMLInputElement>(".follow input").addEventListener("change", (e) => {
  state.follow = (e.target as HTMLInputElement).checked;
  remember.set("padd.follow", state.follow ? "on" : "off");
});

document.addEventListener("keydown", (e) => {
  if ((e.target as Element).closest("input, textarea")) return;
  if ((e.ctrlKey || e.metaKey) && e.key === "z") {
    e.preventDefault();
    void view.undo();
  } else if (e.key === "Escape") {
    closeNav();
    closeComposer();
    closeTalk();
    closeSessionPop();
  }
  else if (e.key === "ArrowLeft") step(1); // older
  else if (e.key === "ArrowRight") step(-1); // newer
});

window.addEventListener("hashchange", () => {
  const h = parseHash();
  if (h && (h[0] !== state.project?.id || h[1] !== state.sub?.id || (h[2] && h[2] !== state.board?.id))) {
    void go(...h);
  }
});

async function start(): Promise<void> {
  setMode("pen");
  setColor(COLORS[0]!.value);
  setSize(4);
  try {
    await loadProjects();
  } catch (err) {
    setStatus("Offline", "error");
    toast(`Can't reach padd: ${(err as Error).message}`);
    return;
  }
  listen();
  const [project, sub, board] = parseHash() ?? (remember.get("padd.place")?.split("/") ?? []);
  if (project && sub && state.projects.some((p) => p.id === project && p.subprojects.some((s) => s.id === sub))) {
    await go(project, sub, board);
    return;
  }
  // Nowhere to go yet: say so and offer the navigator.
  const empty = $<HTMLElement>(".empty");
  empty.hidden = false;
  empty.textContent =
    state.projects.length === 0
      ? "No projects yet. Run padd init in a repo on your computer to add it."
      : "Choose a subproject to start.";
  openNav();
}

void start();
