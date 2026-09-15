import * as vw from '../vw/virtual-world';
import type { VwEditor as VwEditorTool, VwGraph, VwViewport, VwWorld } from '../vw/virtual-world';

export type VwTool = 'graph' | 'stop' | 'yield' | 'crossing' | 'parking' | 'light' | 'start' | 'target';

export interface VwEditorHandlers {
  /** the world's roads/markings changed (regenerated) */
  changed(world: VwWorld): void;
  /** a different world object was loaded (file / dispose) */
  replaced(world: VwWorld): void;
}

const WORLD_KEY = 'vw.world';

/**
 * The upstream virtual-world editor embedded as an overlay: its canvas, viewport and editors run
 * unchanged (top-down 2D drawing is how the world is authored); the 3D view updates live.
 */
export class VwEditorPanel {
  private root = document.getElementById('vw-editor') as HTMLElement;
  private canvas = document.getElementById('vw-canvas') as HTMLCanvasElement;
  private ctx = this.canvas.getContext('2d')!;
  private osmPanel = document.getElementById('vw-osm-panel') as HTMLElement;
  private osmText = document.getElementById('vw-osm-text') as HTMLTextAreaElement;
  private viewport!: VwViewport;
  private tools!: Record<VwTool, VwEditorTool>;
  private graph!: VwGraph;
  private tool: VwTool = 'graph';
  private raf = 0;
  private lastHash = '';

  constructor(
    private world: VwWorld,
    private handlers: VwEditorHandlers,
  ) {
    this.bindWorld(world);
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-tool]')) {
      btn.addEventListener('click', () => this.setTool(btn.dataset.tool as VwTool));
    }
    document.getElementById('vw-close')!.addEventListener('click', () => this.close());
    document.getElementById('vw-dispose')!.addEventListener('click', () => this.dispose());
    document.getElementById('vw-save')!.addEventListener('click', () => this.save());
    document.getElementById('vw-osm')!.addEventListener('click', () => (this.osmPanel.hidden = false));
    document.getElementById('vw-osm-cancel')!.addEventListener('click', () => (this.osmPanel.hidden = true));
    document.getElementById('vw-osm-ok')!.addEventListener('click', () => this.parseOsm());
    const file = document.getElementById('vw-file') as HTMLInputElement;
    file.addEventListener('change', () => {
      const f = file.files?.[0];
      if (f) void this.loadFile(f);
      file.value = '';
    });
  }

  private bindWorld(world: VwWorld): void {
    this.world = world;
    this.graph = world.graph;
    vw.setEditorWorld(world);
    this.viewport = new vw.Viewport(this.canvas, world.zoom ?? 1, world.offset ?? null);
    this.tools = {
      graph: new vw.GraphEditor(this.viewport, this.graph),
      stop: new vw.StopEditor(this.viewport, world),
      crossing: new vw.CrossingEditor(this.viewport, world),
      start: new vw.StartEditor(this.viewport, world),
      parking: new vw.ParkingEditor(this.viewport, world),
      light: new vw.LightEditor(this.viewport, world),
      target: new vw.TargetEditor(this.viewport, world),
      yield: new vw.YieldEditor(this.viewport, world),
    };
    this.lastHash = this.graph.hash();
    if (this.isOpen()) this.setTool(this.tool);
  }

  /** Swap in a world loaded elsewhere (e.g. the dev panel's "big.world" button). */
  setWorld(world: VwWorld): void {
    if (this.isOpen()) this.disableAll();
    this.bindWorld(world);
  }

  isOpen(): boolean {
    return !this.root.hidden;
  }

  open(): void {
    this.root.hidden = false;
    this.setTool(this.tool);
    cancelAnimationFrame(this.raf);
    this.animate();
  }

  close(): void {
    this.disableAll();
    this.root.hidden = true;
    cancelAnimationFrame(this.raf);
  }

  toggle(): void {
    if (this.isOpen()) this.close();
    else this.open();
  }

  private setTool(tool: VwTool): void {
    this.disableAll();
    this.tool = tool;
    this.tools[tool].enable();
    for (const btn of this.root.querySelectorAll<HTMLButtonElement>('[data-tool]')) btn.classList.toggle('active', btn.dataset.tool === tool);
  }

  private disableAll(): void {
    for (const t of Object.values(this.tools)) t.disable();
  }

  private animate = (): void => {
    if (!this.isOpen()) return;
    this.viewport.reset();
    if (this.graph.hash() !== this.lastHash) {
      this.world.generate();
      this.lastHash = this.graph.hash();
      this.handlers.changed(this.world);
    }
    const viewPoint = vw.scale(this.viewport.getOffset(), -1);
    this.world.draw(this.ctx, viewPoint);
    this.ctx.globalAlpha = 0.3;
    for (const t of Object.values(this.tools)) t.display();
    this.ctx.globalAlpha = 1;
    this.raf = requestAnimationFrame(this.animate);
  };

  private dispose(): void {
    this.tools.graph.dispose?.();
    this.world.markings.length = 0;
    this.world.generate();
    this.lastHash = this.graph.hash();
    this.handlers.replaced(this.world);
  }

  /** Upstream "save": download a .world file and remember it locally. */
  private save(): void {
    this.world.zoom = this.viewport.zoom;
    this.world.offset = this.viewport.offset;
    const json = JSON.stringify(this.world);
    try {
      localStorage.setItem(WORLD_KEY, json);
    } catch {
      /* storage may be unavailable */
    }
    const a = document.createElement('a');
    a.href = 'data:application/json;charset=utf-8,' + encodeURIComponent(json);
    a.download = 'name.world';
    a.click();
  }

  private async loadFile(file: File): Promise<void> {
    const text = await file.text();
    const world = vw.World.load(JSON.parse(text));
    try {
      localStorage.setItem(WORLD_KEY, JSON.stringify(world));
    } catch {
      /* ignore */
    }
    this.setWorld(world);
    this.handlers.replaced(world);
  }

  private parseOsm(): void {
    if (!this.osmText.value.trim()) return;
    try {
      const res = vw.Osm.parseRoads(JSON.parse(this.osmText.value));
      this.graph.points = res.points;
      this.graph.segments = res.segments;
      this.osmPanel.hidden = true;
    } catch (err) {
      alert(`Could not parse OSM data: ${err instanceof Error ? err.message : err}`);
    }
  }

  static storedWorld(): VwWorld | null {
    try {
      const raw = localStorage.getItem(WORLD_KEY);
      return raw ? vw.World.load(JSON.parse(raw)) : null;
    } catch {
      return null;
    }
  }
}
