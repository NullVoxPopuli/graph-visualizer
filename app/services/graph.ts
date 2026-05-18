import { tracked } from "@glimmer/tracking";
import Service from "@ember/service";

import { type IDBPDatabase, openDB } from "idb";

import { parseGraphJson } from "#lib/parser";

import type { LoadedGraph } from "#lib/types";

const DB_NAME = "graph-visualizer";
const STORE_NAME = "storage";
const DATA_KEY = "file-data";
const NAME_KEY = "file-name";
const DB_VERSION = 1;

/**
 * Owns the currently-viewed graph and persists the source JSON to
 * IndexedDB so a page reload restores it. Pattern lifted from
 * `turborepo-summary-analyzer/app/file.ts` — IDB holds the raw text
 * (not the parsed buffers), so on restore we re-run the parser and end
 * up with the exact same in-memory shape as a fresh upload.
 */
export default class GraphService extends Service {
  @tracked current: LoadedGraph | null = null;
  /**
   * The raw JSON text the current graph was parsed from. Retained (not
   * just persisted to IDB) because the resident WASM session re-parses it
   * once in Rust — the Rust parser is a faithful port of the JS one, so
   * both produce identically-ordered node indices and the session's
   * communities/positions line up 1:1 with `current.ids`.
   */
  @tracked currentText: string | null = null;
  @tracked fileName: string | null = null;
  /**
   * True while we're attempting to read a previously-stored graph from
   * IDB at app boot. The /view template reads this to decide between
   * "restoring..." vs the empty-state message.
   */
  @tracked restoring = true;

  #db: IDBPDatabase | undefined;
  /**
   * Flips true the moment the user (or some non-restore code path) sets
   * a graph. The IDB restore checks this before clobbering — without the
   * guard, a click on an example link that resolves faster than the IDB
   * round-trip is silently overwritten by whatever was last persisted.
   */
  #userLoadSeen = false;

  constructor(...args: ConstructorParameters<typeof Service>) {
    super(...args);
    void this.#tryLoadFromStorage();
  }

  get isLoaded(): boolean {
    return this.current !== null;
  }

  get nodeCount(): number {
    return this.current?.ids.length ?? 0;
  }

  get edgeCount(): number {
    return (this.current?.edgesFlat.length ?? 0) / 2;
  }

  /**
   * Set the currently-loaded graph and (when source text is provided)
   * persist it to IDB so it'll be restored on the next page load. The
   * text is the original input — the parser is idempotent over it.
   */
  async load(g: LoadedGraph, source?: { text: string; name: string }): Promise<void> {
    this.#userLoadSeen = true;
    this.current = g;
    this.currentText = source?.text ?? null;
    this.fileName = source?.name ?? null;

    if (!source) return;

    try {
      const db = await this.#ensureDb();

      await db.put(STORE_NAME, source.text, DATA_KEY);
      await db.put(STORE_NAME, source.name, NAME_KEY);
    } catch (err) {
      // Persistence failures shouldn't block the user from exploring the
      // graph that's already in memory.

      console.error("Failed to persist graph to IDB:", err);
    }
  }

  async clear(): Promise<void> {
    this.#userLoadSeen = true;
    this.current = null;
    this.currentText = null;
    this.fileName = null;

    try {
      const db = await this.#ensureDb();

      await db.delete(STORE_NAME, DATA_KEY);
      await db.delete(STORE_NAME, NAME_KEY);
    } catch (err) {
      console.error("Failed to clear stored graph from IDB:", err);
    }
  }

  async #ensureDb(): Promise<IDBPDatabase> {
    if (this.#db) return this.#db;
    this.#db = await openDB(DB_NAME, DB_VERSION, {
      upgrade(db) {
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          db.createObjectStore(STORE_NAME);
        }
      },
    });

    return this.#db;
  }

  async #tryLoadFromStorage(): Promise<void> {
    try {
      const db = await this.#ensureDb();
      const [text, name] = await Promise.all([
        db.get(STORE_NAME, DATA_KEY) as Promise<string | undefined>,
        db.get(STORE_NAME, NAME_KEY) as Promise<string | undefined>,
      ]);

      // If the user already loaded something while we were waiting on IDB,
      // don't clobber it. This is the race that used to leave the cycles
      // panel (and HUD, and canvas) stuck on the previously persisted file.
      if (text && !this.#userLoadSeen) {
        const parsed = parseGraphJson(text);

        if (!this.#userLoadSeen) {
          this.current = parsed;
          this.currentText = text;
          this.fileName = name ?? null;
        }
      }
    } catch (err) {
      console.error("Failed to restore graph from IDB:", err);
    } finally {
      this.restoring = false;
    }
  }
}
